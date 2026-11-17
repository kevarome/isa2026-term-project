import { classify, clefModel, departments, urgencyLevels } from './classifier.js';

const statuses = ['manual_review', 'open', 'in_progress', 'resolved', 'closed'];
const priorityRank = { low: 1, medium: 2, high: 3 };
const priorityOrder = "CASE t.urgency WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END";
const pageSize = 30;

function represent(record, staff = false) {
  const { id, message, department, urgency, confidence, status, created_at, updated_at } = record;
  const ticket = { id, message, department, urgency, priority: urgency, confidence, status, created_at, updated_at };
  if (staff) {
    Object.assign(ticket, {
      email: record.email,
      version: record.version,
      classification_outcome: record.classification_outcome,
      classification_model: record.classification_model,
      classification_department: record.suggested_department,
      classification_urgency: record.suggested_urgency,
      jev_department: record.suggested_department,
      jev_urgency: record.suggested_urgency
    });
  }
  return ticket;
}

function pageKey(ticket, sort) {
  return sort === 'priority'
    ? [priorityRank[ticket.urgency] ?? 0, ticket.created_at, ticket.id]
    : [ticket.created_at, ticket.id];
}

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

function supportRole(user) {
  return user.role === 'staff' || user.role === 'admin';
}

export function registerTicketRoutes(app, env, authenticate, requireAdmin) {
  const db = env.DB;

  function requireSupport(_req, res, next) {
    if (!supportRole(res.locals.user)) {
      return res.status(403).json({ error: 'Support staff access required.' });
    }
    next();
  }

  async function listTickets(req, res) {
    const user = res.locals.user;
    const staff = supportRole(user);
    const legacy = req.path === '/api/admin/tickets';
    const { after = '', department = '', status = '', q = '', sort = staff && !legacy ? 'priority' : 'newest' } = req.query;
    if (typeof after !== 'string' || !['priority', 'newest'].includes(sort) ||
        typeof q !== 'string' || q.length > 200 || typeof department !== 'string' ||
        (department !== '' && department !== 'unassigned' && !Object.hasOwn(departments, department)) ||
        (status !== '' && !statuses.includes(status))) {
      return res.status(400).json({ error: 'Invalid ticket filters.' });
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
        const earlier = await db.prepare('SELECT * FROM tickets WHERE id = ?').bind(after).first();
        if (!earlier) return res.json({ tickets: [], next: null });
        values.push(...pageKey(earlier, sort));
      } else {
        const key = decodeCursor(after, sort);
        if (!key) return res.status(400).json({ error: 'Invalid ticket page cursor.' });
        values.push(...key);
      }
      filters.push(`(${orderColumns.join(', ')}) < (${orderColumns.map(() => '?').join(', ')})`);
    }
    const query = db.prepare(`
      SELECT t.*${staff ? ', u.email' : ''}
      FROM tickets t
      ${staff ? 'JOIN users u ON u.id = t.user_id' : ''}
      ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
      ORDER BY ${orderColumns.map(column => column + ' DESC').join(', ')}
      LIMIT ?
    `).bind(...values, pageSize + 1);
    const [result, usage] = staff
      ? [await query.all()]
      : await db.batch([
          query,
          db.prepare('SELECT COUNT(*) AS count FROM api_usage WHERE user_id = ?').bind(user.id)
        ]);
    const page = result.results.slice(0, pageSize);
    let next = null;
    if (result.results.length > pageSize) {
      const last = page.at(-1);
      next = legacy ? last.id : Buffer.from(JSON.stringify([sort, ...pageKey(last, sort)])).toString('base64url');
    }
    const response = { tickets: page.map(ticket => represent(ticket, staff)), next };
    if (usage) response.usage = usage.results[0].count;
    res.json(response);
  }

  app.get('/api/tickets', authenticate, listTickets);
  app.get('/api/admin/tickets', authenticate, requireAdmin, listTickets);

  app.post('/api/tickets', authenticate, async (req, res) => {
    const userId = res.locals.user.id;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (message.length < 10 || message.length > 2000) {
      return res.status(400).json({ error: 'Describe the issue in 10 to 2,000 characters.' });
    }
    if (!(await env.TICKET_LIMIT.limit({ key: userId })).success) {
      return res.status(429).json({ error: 'Ticket limit reached. Try again in a minute.' });
    }
    const ai = env.AI_MODE === 'offline' ? undefined : env.AI;
    const model = env.AI_MODEL || clefModel;
    const result = await classify(ai, message, model);
    const [insert] = await db.batch([
      db.prepare(`
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
      db.prepare("INSERT INTO api_usage (user_id, endpoint, outcome) VALUES (?, 'POST /api/tickets', ?)")
        .bind(userId, result.outcome)
    ]);
    res.status(201).json({ ticket: represent(insert.results[0]) });
  });

  app.get('/api/tickets/:id', authenticate, async (req, res) => {
    const user = res.locals.user;
    const staff = supportRole(user);
    const record = staff
      ? await db.prepare('SELECT t.*, u.email FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?')
        .bind(req.params.id).first()
      : await db.prepare('SELECT * FROM tickets WHERE id = ? AND user_id = ?')
        .bind(req.params.id, user.id).first();
    if (!record) return res.status(404).json({ error: 'Ticket not found.' });
    res.json({ ticket: represent(record, staff) });
  });

  app.patch('/api/tickets/:id', authenticate, requireSupport, async (req, res) => {
    const changes = req.body;
    const editable = ['department', 'priority', 'status'];
    if (!changes || Array.isArray(changes) ||
        !Object.keys(changes).some(key => editable.includes(key)) ||
        Object.keys(changes).some(key => !editable.includes(key) && key !== 'version')) {
      return res.status(400).json({ error: 'Provide a department, priority, or status update.' });
    }
    const { department, priority, status, version } = changes;
    if ((department !== undefined && department !== null &&
          (typeof department !== 'string' || !Object.hasOwn(departments, department))) ||
        (priority !== undefined && priority !== null &&
          (typeof priority !== 'string' || !Object.hasOwn(urgencyLevels, priority))) ||
        (status !== undefined && !statuses.includes(status)) ||
        (version !== undefined && (!Number.isSafeInteger(version) || version < 1))) {
      return res.status(400).json({ error: 'Invalid department, priority, status, or version.' });
    }
    const record = await db.prepare('SELECT t.*, u.email FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?')
      .bind(req.params.id).first();
    if (!record) return res.status(404).json({ error: 'Ticket not found.' });
    if (version !== undefined && version !== record.version) {
      return res.status(409).json({ error: 'This ticket changed. Reload it before saving again.' });
    }
    const nextDepartment = department === undefined ? record.department : department;
    const nextPriority = priority === undefined ? record.urgency : priority;
    const nextStatus = status ?? (record.status === 'manual_review' && department ? 'open' : record.status);
    const updated = await db.prepare(`
      UPDATE tickets
      SET department = ?, urgency = ?, status = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now'),
          version = version + 1
      WHERE id = ? AND version = ?
      RETURNING *
    `).bind(nextDepartment, nextPriority, nextStatus, record.id, record.version).first();
    if (!updated) return res.status(409).json({ error: 'This ticket changed. Reload it before saving again.' });
    res.json({ ticket: represent({ ...updated, email: record.email }, true) });
  });

  app.get('/api/stats', authenticate, requireSupport, async (_req, res) => {
    const { results } = await db.prepare(`
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
  });
}
