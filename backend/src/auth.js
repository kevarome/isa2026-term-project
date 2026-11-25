import { messages } from './messages.js';
import { hashPassword, verifyPassword } from './password.js';
import { resetDelivery, resetLinkMinutes } from './reset-delivery.js';

import { sessionCookieName, sessionCookieOptions, sessionSeconds, signSession, verifySession } from './session.js';

const demoEmails = [
  'john@john.com', 'admin@admin.com',
  'billing@example.test', 'technical@example.test', 'account@example.test', 'general@example.test'
];
// Keep the effective role consistent when reading legacy staff accounts and the admin directory.
export const roleColumn = "CASE WHEN staff.department IS NOT NULL AND u.role = 'user' THEN 'staff' ELSE u.role END AS role";

// Build the public user identity from a database row.
// Include a department for staff accounts and return only the fields the client needs.
function identity({ id, email, role, department }) {
  const user = { id, email, role };
  if (role === 'staff') user.department = department;
  return user;
}

// Hash an opaque session or reset token with SHA-256 and return it as hex.
// The database uses this digest to look up tokens while the client retains the original.
async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(hash).toString('hex');
}

// Generate 32 cryptographically random bytes and encode them as a 64-character hex token.
const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
// Trim and lowercase email strings for consistent account lookup. Treat other input types as empty.
const normalizeEmail = email => typeof email === 'string' ? email.trim().toLowerCase() : '';
// Check the length and expected address structure of a normalized email.
const validEmail = email => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
// Require a string of 12 to 128 characters for registration and password resets.
// Sign-in checks existing passwords with its own input rules.
const validNewPassword = password => typeof password === 'string' && password.length >= 12 && password.length <= 128;

// Manage customer registration, login sessions, and password recovery against the same D1 database.
export class AuthController {
  #env;
  #db;
  #waitUntil;

  // Keep the live environment bindings so each request uses the current delivery and rate-limit settings.
  constructor(env, waitUntil) {
    this.#env = env;
    this.#db = env.DB;
    this.#waitUntil = waitUntil;
  }

  // Install the rate-limited public endpoints and protect the two active-session endpoints.
  registerRoutes(app) {
    const limit = this.#limit.bind(this);
    app.post('/auth/register', limit, this.#register.bind(this));
    app.post('/auth/login', limit, this.#login.bind(this));
    app.post('/auth/password-reset/request', limit, this.#requestReset.bind(this));
    app.post('/auth/password-reset/confirm', limit, this.#confirmReset.bind(this));
    // Return the active identity so the client can restore the caller's workspace.
    app.get('/auth/me', this.authenticate, (_req, res) => res.json({ user: res.locals.user }));
    app.post('/auth/logout', this.authenticate, this.#logout.bind(this));
  }

  // Apply the authentication rate limit by client IP, using a shared local key when the header is absent.
  // Respond with 429 when the limit is reached.
  async #limit(req, res, next) {
    const key = req.get('CF-Connecting-IP') ?? 'local';
    if (!(await this.#env.AUTH_LIMIT.limit({ key })).success) {
      return res.status(429).json({ error: messages.authRateLimit });
    }
    next();
  }

  // Verify the signed cookie and read the user's current role from its active D1 session.
  // Place the public identity and token digest in res.locals for downstream handlers.
  authenticate = async (req, res, next) => {
    const cookie = req.get('Cookie')?.split(';').map(value => value.trim())
      .find(value => value.startsWith(sessionCookieName + '='));
    const token = cookie?.slice(sessionCookieName.length + 1);
    const subject = await verifySession(token, this.#env.JWT_SECRET);
    const tokenHash = subject && await digest(token);
    const user = tokenHash && await this.#db.prepare(`
      SELECT u.id, u.email, ${roleColumn}, staff.department
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN staff_profiles staff ON staff.user_id = u.id
      WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > unixepoch()
    `).bind(tokenHash, subject).first();
    if (!user) return res.status(401).json({ error: messages.signInRequired });
    res.locals.user = identity(user);
    res.locals.tokenHash = tokenHash;
    next();
  };

  // Allow an authenticated administrator to proceed. Return 403 for other roles.
  static requireAdmin(_req, res, next) {
    if (res.locals.user.role !== 'admin') {
      return res.status(403).json({ error: messages.adminRequired });
    }
    next();
  }

  // Validate the email and password, reserve demo addresses, and create a customer with a hashed password.
  // The unique email constraint handles overlapping sign-up attempts. The client signs in separately.
  async #register(req, res) {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!validEmail(email)) {
      return res.status(400).json({ error: messages.invalidEmail });
    }
    if (!validNewPassword(password)) {
      return res.status(400).json({ error: messages.passwordLength });
    }
    if (demoEmails.includes(email)) return res.status(409).json({ error: messages.emailReserved });
    const user = { id: crypto.randomUUID(), email, role: 'user' };
    const result = await this.#db.prepare(
      "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user') ON CONFLICT(email) DO NOTHING"
    ).bind(user.id, email, await hashPassword(password)).run();
    if (!result.meta.changes) return res.status(409).json({ error: messages.emailRegistered });
    res.locals.user = user;
    res.status(201).json({ user });
  }

  // Verify the submitted credentials and return a new session token with the public user identity.
  // The session insert rechecks the verified password hash so a concurrent reset prevents a stale login.
  async #login(req, res) {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || email.length > 254 || typeof password !== 'string' || !password || password.length > 128) {
      return res.status(400).json({ error: messages.missingCredentials });
    }
    const record = await this.#db.prepare(`
      SELECT u.id, u.email, u.password_hash, ${roleColumn}, staff.department
      FROM users u
      LEFT JOIN staff_profiles staff ON staff.user_id = u.id
      WHERE u.email = ?
    `).bind(email).first();
    const valid = await verifyPassword(password, record?.password_hash ?? 'unused-salt:' + '0'.repeat(128));
    if (!record || !valid) return res.status(401).json({ error: messages.invalidCredentials });

    const token = await signSession(record.id, this.#env.JWT_SECRET);
    const [, session] = await this.#db.batch([
      this.#db.prepare('DELETE FROM sessions WHERE expires_at <= unixepoch()'),
      this.#db.prepare(`
        INSERT INTO sessions (token_hash, user_id, expires_at)
        SELECT ?, id, unixepoch() + ? FROM users WHERE id = ? AND password_hash = ?
        RETURNING user_id
      `).bind(await digest(token), sessionSeconds, record.id, record.password_hash)
    ]);
    if (!session.results.length) return res.status(401).json({ error: messages.invalidCredentials });
    res.locals.user = identity(record);
    res.cookie(sessionCookieName, token, { ...sessionCookieOptions(this.#env.CLIENT_ORIGIN), maxAge: sessionSeconds * 1000 });
    res.json({ user: res.locals.user });
  }

  // Issue a short-lived reset token when an eligible account exists and is outside the cooldown.
  // Use the same accepted response for unknown addresses and suppress hosted reset email for demo accounts.
  async #requestReset(req, res) {
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: messages.invalidEmail });
    const delivery = resetDelivery(this.#env);
    if (!delivery) return res.status(503).json({ error: messages.resetUnavailable });

    const token = newToken();
    const recoveryEmail = delivery.mode === 'email' && demoEmails.includes(email) ? null : email;
    const [, reset] = await this.#db.batch([
      this.#db.prepare('DELETE FROM password_resets WHERE expires_at <= unixepoch()'),
      this.#db.prepare(`
        INSERT INTO password_resets (token_hash, user_id, expires_at)
        SELECT ?, id, unixepoch() + ? FROM users
        WHERE email = ? AND NOT EXISTS (
          SELECT 1 FROM password_resets WHERE user_id = users.id AND created_at > unixepoch() - 60
        )
        RETURNING user_id
      `).bind(await digest(token), resetLinkMinutes * 60, recoveryEmail)
    ]);
    if (reset.results.length) {
      const sent = delivery.send(email, token).catch(() => console.error('Password reset email delivery failed.'));
      const waitUntil = this.#waitUntil;
      if (waitUntil && delivery.mode === 'email') waitUntil(sent);
      else await sent;
    }
    res.status(202).json({ accepted: true, delivery: delivery.mode });
  }

  // Redeem an unexpired reset token and replace the account's password hash.
  // The update rechecks token expiry, and a database trigger removes the account's sessions and reset links.
  async #confirmReset(req, res) {
    const { token, password } = req.body ?? {};
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).json({ error: messages.invalidReset });
    }
    if (!validNewPassword(password)) return res.status(400).json({ error: messages.passwordLength });
    const tokenHash = await digest(token);
    const pending = await this.#db.prepare('SELECT 1 FROM password_resets WHERE token_hash = ? AND expires_at > unixepoch()')
      .bind(tokenHash).first();
    if (!pending) return res.status(400).json({ error: messages.invalidReset });

    const updated = await this.#db.prepare(`
      UPDATE users SET password_hash = ?
      WHERE id = (SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > unixepoch())
      RETURNING id
    `).bind(await hashPassword(password), tokenHash).first();
    if (!updated) return res.status(400).json({ error: messages.invalidReset });
    res.json({ reset: true });
  }

  // Delete the session matching the caller's token digest and confirm sign-out.
  async #logout(_req, res) {
    await this.#db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(res.locals.tokenHash).run();
    res.clearCookie(sessionCookieName, sessionCookieOptions(this.#env.CLIENT_ORIGIN));
    res.json({ signedOut: true });
  }
}
