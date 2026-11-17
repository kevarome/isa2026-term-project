import express from 'express';
import { classify } from './classifier.js';
import { hashPassword, verifyPassword } from './password.js';

const SESSION_SECONDS = 8 * 60 * 60;
const demoEmails = ['john@john.com', 'admin@admin.com'];

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
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
    const user = tokenHash && await db.prepare(
      'SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > unixepoch()'
    ).bind(tokenHash).first();
    if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
    res.locals.user = user;
    res.locals.tokenHash = tokenHash;
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
    const record = await db.prepare('SELECT id, email, role, password_hash FROM users WHERE email = ?')
      .bind(email).first();
    const valid = await verifyPassword(password, record?.password_hash ?? 'unused-salt:' + '0'.repeat(128));
    if (!record || !valid) return res.status(401).json({ error: 'Email or password is incorrect.' });

    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE expires_at <= unixepoch()'),
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, unixepoch() + ?)')
        .bind(await digest(token), record.id, SESSION_SECONDS)
    ]);
    res.json({ token, user: { id: record.id, email: record.email, role: record.role } });
  });

  app.get('/api/auth/me', authenticate, (_req, res) => res.json({ user: res.locals.user }));
  app.post('/api/auth/logout', authenticate, async (_req, res) => {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(res.locals.tokenHash).run();
    res.json({ signedOut: true });
  });

  app.get('/api/tickets', authenticate, async (_req, res) => {
    const id = res.locals.user.id;
    const [tickets, usage] = await db.batch([
      db.prepare('SELECT id, message, department, urgency, confidence, status, created_at FROM tickets WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 30').bind(id),
      db.prepare('SELECT COUNT(*) AS count FROM api_usage WHERE user_id = ?').bind(id)
    ]);
    res.json({ tickets: tickets.results, usage: usage.results[0].count });
  });

  app.post('/api/tickets', authenticate, async (req, res) => {
    const userId = res.locals.user.id;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (message.length < 10 || message.length > 2000) {
      return res.status(400).json({ error: 'Describe the issue in 10 to 2,000 characters.' });
    }
    if (!(await env.TICKET_LIMIT.limit({ key: userId })).success) {
      return res.status(429).json({ error: 'Ticket limit reached. Try again in a minute.' });
    }
    const { outcome, ...routing } = await classify(env.AI, message);
    const id = crypto.randomUUID();
    const [insert] = await db.batch([
      db.prepare('INSERT INTO tickets (id, user_id, message, department, urgency, confidence, status) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, message, department, urgency, confidence, status, created_at')
        .bind(id, userId, message, routing.department, routing.urgency, routing.confidence, routing.status),
      db.prepare("INSERT INTO api_usage (user_id, endpoint, outcome) VALUES (?, 'POST /api/tickets', ?)")
        .bind(userId, outcome)
    ]);
    res.status(201).json({ ticket: insert.results[0] });
  });

  app.get('/api/admin/users', authenticate, async (req, res) => {
    if (res.locals.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
    const after = typeof req.query.after === 'string' ? req.query.after : '';
    const [users, totals] = await db.batch([
      db.prepare('SELECT id, email, role, created_at FROM users WHERE email > ? ORDER BY email LIMIT 51').bind(after),
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
