import { messages } from './messages.js';
import { Ticket } from './ticket.js';
import { TicketClassifier, clefModel, departments, urgencyLevels } from './classifier.js';

const statuses = ['manual_review', 'open', 'in_progress', 'resolved', 'closed'];
const priorityOrder = "CASE t.urgency WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END";
const pageSize = 30;

// Decode a base64url ticket cursor and check its sort mode, shape, and field values.
// Return null for malformed or incompatible cursors before they reach the database query.
function decodeCursor(cursor, sort) {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (!Array.isArray(decoded) || decoded[0] !== sort || decoded.length !== (sort === 'priority' ? 4 : 3)) {
      return null;
    }
    const [created, id] = decoded.slice(-2);
    if (typeof created !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(created) ||
        typeof id !== 'string' || id.length < 1 || id.length > 128) {
      return null;
    }
    if (sort === 'priority' && ![0, 1, 2, 3].includes(decoded[1])) return null;
    return decoded.slice(1);
  } catch {
    return null;
  }
}

// Identify roles that can read the support queues and edit tickets across customer accounts.
function supportRole(user) {
  return user.role === 'staff' || user.role === 'admin';
}

// Coordinate the authenticated ticket endpoints with the D1 store, AI provider, and submission limit.
export class TicketController {
  // Keep the database connection and Worker bindings used by this application's requests.
  constructor(env) {
    this.db = env.DB;
    this.env = env;
  }

  // Mount the endpoints with their access checks and bind handlers to this controller.
  registerRoutes(app, authenticate, requireAdmin) {
    const list = this.listTickets.bind(this);
    app.get('/api/tickets', authenticate, list);
    app.get('/api/admin/tickets', authenticate, requireAdmin, list);
    app.post('/api/tickets', authenticate, this.createTicket.bind(this));
    app.get('/api/tickets/:id', authenticate, this.getTicket.bind(this));
    app.patch('/api/tickets/:id', authenticate, this.requireSupport, this.updateTicket.bind(this));
    app.get('/api/stats', authenticate, this.requireSupport, this.getStats.bind(this));
  }

  // Require a staff or administrator role after authentication and return 403 for other callers.
  requireSupport(_req, res, next) {
    if (!supportRole(res.locals.user)) {
      return res.status(403).json({ error: messages.staffRequired });
    }
    next();
  }

  // Return a filtered page of tickets visible to the caller and a cursor when more results exist.
  // Customers get their own tickets and submission count. The legacy admin route uses an ID cursor.
  async listTickets(req, res) {
    const user = res.locals.user;
    const staff = supportRole(user);
    const legacy = req.path === '/api/admin/tickets';
    const { after = '', department = '', status = '', q = '', sort = staff && !legacy ? 'priority' : 'newest' } = req.query;
    if (typeof after !== 'string' || !['priority', 'newest'].includes(sort) ||
        typeof q !== 'string' || q.length > 200 || typeof department !== 'string' ||
        (department !== '' && department !== 'unassigned' && !Object.hasOwn(departments, department)) ||
        (status !== '' && !statuses.includes(status))) {
      return res.status(400).json({ error: messages.invalidFilters });
    }

    const filters = [];
    const values = [];
    if (!staff) {
      filters.push('t.user_id = ?');
      values.push(user.id);
    }
    if (department === 'unassigned') {
      filters.push('t.department IS NULL');
    } else if (department) {
      filters.push('t.department = ?');
      values.push(department);
    }
    if (status) {
      filters.push('t.status = ?');
      values.push(status);
    }
    const term = q.trim();
    if (term) {
      const searchColumns = staff ? ['t.message', 't.id', 'u.email'] : ['t.message', 't.id'];
      filters.push('(' + searchColumns.map(column => `instr(lower(${column}), lower(?)) > 0`).join(' OR ') + ')');
      values.push(...searchColumns.map(() => term));
    }
    const orderColumns = sort === 'priority' ? [priorityOrder, 't.created_at', 't.id'] : ['t.created_at', 't.id'];
    if (after) {
      if (legacy) {
        const earlier = await this.db.prepare('SELECT * FROM tickets WHERE id = ?').bind(after).first();
        if (!earlier) return res.json({ tickets: [], next: null });
        values.push(...new Ticket(earlier).pageKey(sort));
      } else {
        const key = decodeCursor(after, sort);
        if (!key) return res.status(400).json({ error: messages.invalidCursor });
        values.push(...key);
      }
      filters.push(`(${orderColumns.join(', ')}) < (${orderColumns.map(() => '?').join(', ')})`);
    }
    const query = this.db.prepare(`
      SELECT t.*${staff ? ', u.email' : ''}
      FROM tickets t
      ${staff ? 'JOIN users u ON u.id = t.user_id' : ''}
      ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
      ORDER BY ${orderColumns.map(column => column + ' DESC').join(', ')}
      LIMIT ?
    `).bind(...values, pageSize + 1);
    const [result, usage] = staff
      ? [await query.all()]
      : await this.db.batch([
          query,
          this.db.prepare('SELECT COUNT(*) AS count FROM api_usage WHERE user_id = ?').bind(user.id)
        ]);
    const page = result.results.slice(0, pageSize).map(record => new Ticket(record));
    let next = null;
    if (result.results.length > pageSize) {
      next = page.at(-1).nextCursor(sort, legacy);
    }
    const response = { tickets: page.map(ticket => ticket.toResponse(staff)), next };
    if (usage) response.usage = usage.results[0].count;
    res.json(response);
  }

  // Validate the message, apply the per-user submission limit, and classify the ticket when AI is available.
  // Save the ticket and its submission usage together, keeping the original AI result for staff review.
  async createTicket(req, res) {
    const userId = res.locals.user.id;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (message.length < 10 || message.length > 2000) {
      return res.status(400).json({ error: messages.messageLength });
    }
    if (!(await this.env.TICKET_LIMIT.limit({ key: userId })).success) {
      return res.status(429).json({ error: messages.ticketRateLimit });
    }
    const ai = this.env.AI_MODE === 'offline' ? undefined : this.env.AI;
    const model = this.env.AI_MODEL || clefModel;
    const classifier = new TicketClassifier(ai, model);
    const result = await classifier.classify(message);
    const [insert] = await this.db.batch([
      this.db.prepare(`
        INSERT INTO tickets (
          id, user_id, message, department, urgency, confidence, status,
          classification_outcome, suggested_department, suggested_urgency, classification_model
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `).bind(
        crypto.randomUUID(), userId, message, result.department, result.urgency, result.confidence,
        result.status, result.outcome, result.suggestion?.department ?? null,
        result.suggestion?.urgency ?? null, ai ? model : null
      ),
      this.db.prepare("INSERT INTO api_usage (user_id, endpoint, outcome) VALUES (?, 'POST /api/tickets', ?)")
        .bind(userId, result.outcome)
    ]);
    res.status(201).json({ ticket: new Ticket(insert.results[0]).toResponse() });
  }

  // Fetch a single ticket for its owner or a support user.
  // Return the same 404 for missing tickets and tickets outside the customer's account.
  async getTicket(req, res) {
    const user = res.locals.user;
    const staff = supportRole(user);
    const record = staff
      ? await this.db.prepare('SELECT t.*, u.email FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?')
        .bind(req.params.id).first()
      : await this.db.prepare('SELECT * FROM tickets WHERE id = ? AND user_id = ?')
        .bind(req.params.id, user.id).first();
    if (!record) return res.status(404).json({ error: messages.ticketMissing });
    res.json({ ticket: new Ticket(record).toResponse(staff) });
  }

  // Apply a support user's changes to assignment, priority, or status. Omitted fields keep their values.
  // Check the stored version during the write to detect concurrent edits and preserve the original AI result.
  async updateTicket(req, res) {
    const changes = req.body;
    const editable = ['department', 'priority', 'status'];
    if (!changes || Array.isArray(changes) ||
        !Object.keys(changes).some(key => editable.includes(key)) ||
        Object.keys(changes).some(key => !editable.includes(key) && key !== 'version')) {
      return res.status(400).json({ error: messages.missingEdit });
    }
    const { department, priority, status, version } = changes;
    if ((department !== undefined && department !== null &&
          (typeof department !== 'string' || !Object.hasOwn(departments, department))) ||
        (priority !== undefined && priority !== null &&
          (typeof priority !== 'string' || !Object.hasOwn(urgencyLevels, priority))) ||
        (status !== undefined && !statuses.includes(status)) ||
        (version !== undefined && (!Number.isSafeInteger(version) || version < 1))) {
      return res.status(400).json({ error: messages.invalidEdit });
    }
    const record = await this.db.prepare('SELECT t.*, u.email FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?')
      .bind(req.params.id).first();
    if (!record) return res.status(404).json({ error: messages.ticketMissing });
    if (version !== undefined && version !== record.version) {
      return res.status(409).json({ error: messages.editConflict });
    }
    const next = new Ticket(record).routingAfter(changes);
    const updated = await this.db.prepare(`
      UPDATE tickets
      SET department = ?, urgency = ?, status = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now'),
          version = version + 1
      WHERE id = ? AND version = ?
      RETURNING *
    `).bind(next.department, next.priority, next.status, record.id, record.version).first();
    if (!updated) return res.status(409).json({ error: messages.editConflict });
    res.json({ ticket: new Ticket({ ...updated, email: record.email }).toResponse(true) });
  }

  // Count tickets by original AI category, current department, status, and priority.
  // Initialize empty categories to zero so the client receives a consistent response.
  async getStats(_req, res) {
    const { results } = await this.db.prepare(`
      SELECT suggested_department AS category, department, status, urgency, COUNT(*) AS count
      FROM tickets
      GROUP BY suggested_department, department, status, urgency
    `).all();
    const stats = { total: 0, byCategory: {}, byDepartment: {}, byStatus: {}, byPriority: {} };
    for (const category of [...Object.keys(departments), 'unclassified']) stats.byCategory[category] = 0;
    for (const department of [...Object.keys(departments), 'unassigned']) stats.byDepartment[department] = 0;
    for (const status of statuses) stats.byStatus[status] = 0;
    for (const priority of [...Object.keys(urgencyLevels), 'unprioritized']) stats.byPriority[priority] = 0;
    for (const { category, department, status, urgency, count } of results) {
      stats.total += count;
      stats.byCategory[category ?? 'unclassified'] += count;
      stats.byDepartment[department ?? 'unassigned'] += count;
      stats.byStatus[status] += count;
      stats.byPriority[urgency ?? 'unprioritized'] += count;
    }
    res.json(stats);
  }
}

// Register tickets for existing application factories that supply the Worker bindings directly.
export function registerTicketRoutes(app, env, authenticate, requireAdmin) {
  new TicketController(env).registerRoutes(app, authenticate, requireAdmin);
}
