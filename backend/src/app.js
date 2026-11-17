import express from 'express';
import { hashPassword, verifyPassword } from './password.js';
import { registerTicketRoutes } from './tickets.js';

const SESSION_SECONDS = 8 * 60 * 60;
const demoEmails = [
  'john@john.com', 'admin@admin.com',
  'billing@example.test', 'technical@example.test', 'account@example.test', 'general@example.test'
];
const roleColumn = "CASE WHEN staff.department IS NOT NULL AND u.role = 'user' THEN 'staff' ELSE u.role END AS role";

function identity({ id, email, role, department }) {
  const user = { id, email, role };
  if (role === 'staff') user.department = department;
  return user;
}

async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(hash).toString('hex');
}

export function createApp(env) {
  const app = express();
  const db = env.DB;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store').vary('Origin');
    const origin = req.get('Origin');
    if (origin && origin !== env.CLIENT_ORIGIN) {
      return res.status(403).json({ error: 'Origin is not allowed.' });
    }
    if (origin) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type'
      });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  async function authLimit(req, res, next) {
    const key = req.get('CF-Connecting-IP') ?? 'local';
    if (!(await env.AUTH_LIMIT.limit({ key })).success) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    }
    next();
  }

  async function authenticate(req, res, next) {
    const token = req.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
    const tokenHash = token && await digest(token);
    const user = tokenHash && await db.prepare(`
      SELECT u.id, u.email, ${roleColumn}, staff.department
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN staff_profiles staff ON staff.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > unixepoch()
    `).bind(tokenHash).first();
    if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
    res.locals.user = identity(user);
    res.locals.tokenHash = tokenHash;
    next();
  }

  function requireAdmin(_req, res, next) {
    if (res.locals.user.role !== 'admin') {
      return res.status(403).json({ error: 'Administrator access required.' });
    }
    next();
  }

  app.get('/api/health', async (_req, res) => {
    await db.prepare('SELECT id FROM users LIMIT 1').first();
    res.json({ status: 'ok', database: 'connected' });
  });

  app.post('/api/auth/register', authLimit, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: 'Use a password between 12 and 128 characters.' });
    }
    if (demoEmails.includes(email)) return res.status(409).json({ error: 'This email is reserved.' });
    const user = { id: crypto.randomUUID(), email, role: 'user' };
    const result = await db.prepare(
      "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user') ON CONFLICT(email) DO NOTHING"
    ).bind(user.id, email, await hashPassword(password)).run();
    if (!result.meta.changes) return res.status(409).json({ error: 'This email is already registered.' });
    res.status(201).json({ user });
  });

  app.post('/api/auth/login', authLimit, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    if (!email || email.length > 254 || typeof password !== 'string' || !password || password.length > 128) {
      return res.status(400).json({ error: 'Enter your email and password.' });
    }
    const record = await db.prepare(`
      SELECT u.id, u.email, u.password_hash, ${roleColumn}, staff.department
      FROM users u
      LEFT JOIN staff_profiles staff ON staff.user_id = u.id
      WHERE u.email = ?
    `).bind(email).first();
    const valid = await verifyPassword(password, record?.password_hash ?? 'unused-salt:' + '0'.repeat(128));
    if (!record || !valid) return res.status(401).json({ error: 'Email or password is incorrect.' });

    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE expires_at <= unixepoch()'),
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, unixepoch() + ?)')
        .bind(await digest(token), record.id, SESSION_SECONDS)
    ]);
    res.json({ token, user: identity(record) });
  });

  app.get('/api/auth/me', authenticate, (_req, res) => res.json({ user: res.locals.user }));
  app.post('/api/auth/logout', authenticate, async (_req, res) => {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(res.locals.tokenHash).run();
    res.json({ signedOut: true });
  });

  registerTicketRoutes(app, env, authenticate, requireAdmin);

  app.get('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
    const after = typeof req.query.after === 'string' ? req.query.after : '';
    const [users, totals] = await db.batch([
      db.prepare(`
        SELECT u.id, u.email, ${roleColumn}, staff.department, u.created_at
        FROM users u
        LEFT JOIN staff_profiles staff ON staff.user_id = u.id
        WHERE u.email > ?
        ORDER BY u.email
        LIMIT 51
      `).bind(after),
      db.prepare('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM api_usage) AS submissions')
    ]);
    const page = users.results.slice(0, 50);
    res.json({ users: page, next: users.results.length > 50 ? page.at(-1).email : null, totals: totals.results[0] });
  });

  app.use((_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use((error, _req, res, _next) => {
    if (error.status === 400 || error.status === 413) {
      return res.status(error.status).json({ error: error.status === 400 ? 'Invalid JSON.' : 'Request is too large.' });
    }
    console.error('Request failed', error.name);
    res.status(500).json({ error: 'Something went wrong. Try again later.' });
  });
  return app;
}
