import { messages } from './messages.js';
import { roleColumn } from './auth.js';

// Own the account directory and destructive operations shared by the administration routes.
export class AdminController {
  #db;

  // Use the same D1 database that session authentication checks on each request.
  constructor(db) {
    this.#db = db;
  }

  // Apply both access checks to every admin route, including the shared usage report.
  registerRoutes(app, authenticate, requireAdmin, usageReport) {
    app.get('/api/admin/usage', authenticate, requireAdmin, usageReport);
    app.get('/api/admin/users', authenticate, requireAdmin, this.#listUsers.bind(this));
    app.delete('/api/admin/users/:id', authenticate, requireAdmin, this.#deleteAsAdmin('users', messages.userMissing));
    app.delete('/api/admin/tickets/:id', authenticate, requireAdmin, this.#deleteAsAdmin('tickets', messages.ticketMissing));
  }

  // Return up to 50 registered accounts in email order with the overall account and submission totals.
  // Read one extra row to determine whether the client needs the next email cursor.
  async #listUsers(req, res) {
    const after = typeof req.query.after === 'string' ? req.query.after : '';
    const [users, totals] = await this.#db.batch([
      this.#db.prepare(`
        SELECT u.id, u.email, ${roleColumn}, staff.department, u.created_at
        FROM users u
        LEFT JOIN staff_profiles staff ON staff.user_id = u.id
        WHERE u.email > ?
        ORDER BY u.email
        LIMIT 51
      `).bind(after),
      this.#db.prepare('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM api_usage) AS submissions')
    ]);
    const page = users.results.slice(0, 50);
    res.json({ users: page, next: users.results.length > 50 ? page.at(-1).email : null, totals: totals.results[0] });
  }

  // Build a delete handler for the server-selected users or tickets table.
  // Use the supplied message when an authorized deletion targets a missing row.
  #deleteAsAdmin(table, missingMessage) {
    const sessionRole = `SELECT u.role FROM sessions s JOIN users u ON u.id = s.user_id
                         WHERE s.token_hash = ? AND s.expires_at > unixepoch()`;
    // Delete the requested record only while the caller still has an active administrator session.
    // Refuse self-deletion and distinguish an expired session, a role change, and a missing record.
    return async (req, res) => {
      if (table === 'users' && req.params.id === res.locals.user.id) {
        return res.status(409).json({ error: messages.cannotRemoveSelf });
      }
      // Check the session in the write so two admins cannot remove each other.
      const deleted = await this.#db.prepare(`
        DELETE FROM ${table} WHERE id = ? AND (${sessionRole}) = 'admin' RETURNING id
      `).bind(req.params.id, res.locals.tokenHash).first();
      if (deleted) return res.json({ deleted: true });

      const role = await this.#db.prepare(sessionRole).bind(res.locals.tokenHash).first('role');
      if (!role) return res.status(401).json({ error: messages.signInRequired });
      if (role !== 'admin') return res.status(403).json({ error: messages.adminRequired });
      return res.status(404).json({ error: missingMessage });
    };
  }
}
