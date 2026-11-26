import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fixtureResponse, syntheticTickets } from '../fixtures/synthetic-tickets.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/password.js';
import { signSession } from '../src/session.js';

const origin = 'http://localhost:8788';
const fixturePassword = 'synthetic-test-password';
const jwtSecret = randomUUID() + randomUUID();
const fixtureHash = await hashPassword(fixturePassword);
const roles = { owner: 'user', stranger: 'user', staff: 'user', admin: 'admin' };
const emails = Object.fromEntries(Object.keys(roles).map(name => [name, name + '@example.test']));
const samples = syntheticTickets.filter(sample => sample.style === 'plain');

function asD1(database, controls) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      function bind(...args) {
        const all = () => ({ results: statement.all(...args) });
        return {
          all: async () => all(),
          first: async column => {
            const row = statement.get(...args);
            await controls.onRead?.(row);
            return column ? row?.[column] ?? null : row ?? null;
          },
          run: async () => {
            const { changes, lastInsertRowid } = statement.run(...args);
            return { success: true, meta: { changes, last_row_id: lastInsertRowid } };
          },
          execute: all
        };
      }
      return { ...bind(), bind };
    },
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const result = statements.map(statement => statement.execute());
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

async function withApp(t, seedLegacy, waitUntil) {
  const database = new DatabaseSync(':memory:');
  const controls = {};
  t.after(() => database.close());
  const migrations = new URL('../migrations/', import.meta.url);
  const tokens = {};
  for (const migration of readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) {
    database.exec(readFileSync(new URL(migration, migrations), 'utf8'));
    if (migration === '0001_initial.sql') {
      const addUser = database.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)');
      const addSession = database.prepare('INSERT INTO sessions VALUES (?, ?, unixepoch() + 3600)');
      for (const [name, role] of Object.entries(roles)) {
        tokens[name] = await signSession(name, jwtSecret);
        const tokenHash = createHash('sha256').update(tokens[name]).digest('hex');
        addUser.run(name, emails[name], fixtureHash, role);
        addSession.run(tokenHash, name);
      }
      seedLegacy?.(database);
    }
  }
  database.prepare('INSERT INTO staff_profiles (user_id, department) VALUES (?, ?)').run('staff', 'technical');
  let calls = 0;
  const env = {
    DB: asD1(database, controls),
    JWT_SECRET: jwtSecret,
    CLIENT_ORIGIN: origin,
    AUTH_LIMIT: { limit: async () => ({ success: true }) },
    TICKET_LIMIT: { limit: async () => ({ success: true }) },
    AI: {
      run(_modelId, { state }) {
        calls++;
        const sample = samples.find(item => item.message === state.support_message);
        return sample ? fixtureResponse(sample.department, sample.urgency) : fixtureResponse('technical', 'medium', 0.5);
      }
    }
  };
  const server = createApp(env, waitUntil).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  async function request(path, { user, token, method, payload, raw, requestOrigin = origin, extraHeaders } = {}) {
    const headers = { Origin: requestOrigin };
    const credential = token ?? tokens[user];
    if (credential) headers.Cookie = 'ticketmaestro_session=' + credential;
    if (payload !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
    const result = await fetch(base + path, {
      method: method ?? (payload === undefined && raw === undefined ? 'GET' : 'POST'),
      headers: { ...headers, ...extraHeaders },
      body: raw ?? (payload === undefined ? undefined : JSON.stringify(payload))
    });
    return { status: result.status, headers: result.headers, data: result.status === 204 ? null : await result.json() };
  }
  return { request, env, database, controls, calls: () => calls };
}

test('returns a JSON 415 for an unsupported JSON charset or content encoding', async t => {
  const { request } = await withApp(t);
  for (const extraHeaders of [
    { 'Content-Type': 'application/json; charset=iso-8859-1' },
    { 'Content-Encoding': 'unsupported' }
  ]) {
    const result = await request('/auth/login', { payload: {}, extraHeaders });
    assert.equal(result.status, 415);
    assert.match(result.data.error, /UTF-8 JSON/);
  }
});

test('counts authenticated ticket requests rejected by the JSON parser in both usage tables', async t => {
  const { request, calls } = await withApp(t);
  const anonymous = await request('/tickets', { raw: '{' });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('x-api-calls-used'), null);

  const invalid = [
    { status: 400, raw: '{' },
    { status: 413, raw: JSON.stringify({ message: 'x'.repeat(16384) }) },
    { status: 415, raw: '{}', extraHeaders: { 'Content-Type': 'application/json; charset=iso-8859-1' } }
  ];
  for (const [index, { status, ...options }] of invalid.entries()) {
    const result = await request('/tickets', { ...options, user: 'owner' });
    assert.equal(result.status, status);
    assert.equal(result.headers.get('x-api-calls-used'), String(index + 1));
  }
  assert.equal(calls(), 0);
  const { data } = await request('/admin/usage', { user: 'admin' });
  assert.equal(data.userTotals.find(row => row.email === emails.owner).requests, 3);
  const tickets = data.endpointTotals.find(row => row.method === 'POST' && row.route === '/api/v1/tickets');
  assert.equal(tickets.requests, 4);
  assert.equal(tickets.errors, 4);
});

test('resets passwords with an expiring, single-use link and revokes the account sessions', async t => {
  const { request, env, database } = await withApp(t);
  env.PASSWORD_RESET_MODE = 'local';
  const links = [];
  t.mock.method(console, 'log', message => {
    const prefix = 'Password reset link (local): ';
    if (message.startsWith(prefix)) links.push(new URL(message.slice(prefix.length)));
  });
  const resetRequest = email => request('/auth/password-reset/request', { payload: { email } });
  const resetConfirm = (token, password) => request('/auth/password-reset/confirm', { payload: { token, password } });
  const replacement = 'updated-demo-password';
  const unknown = await resetRequest('unknown@example.test');
  assert.equal(unknown.status, 202);
  assert.equal(links.length, 0);
  const known = await resetRequest(' OWNER@example.test ');
  assert.deepEqual(known.data, unknown.data);
  assert.equal(links.length, 1);
  assert.equal(links[0].origin, origin);
  assert.equal(links[0].search, '');
  const firstToken = links[0].hash.slice('#reset-password='.length);
  assert.match(firstToken, /^[a-f0-9]{64}$/);
  const stored = database.prepare('SELECT token_hash, expires_at - created_at AS lifetime FROM password_resets').get();
  assert.equal(stored.token_hash, createHash('sha256').update(firstToken).digest('hex'));
  assert.equal(stored.lifetime, 1800);
  assert.deepEqual((await resetRequest(emails.owner)).data, unknown.data);
  assert.equal(links.length, 1);
  database.exec('UPDATE password_resets SET expires_at = unixepoch() - 1');
  assert.equal((await resetConfirm(firstToken, replacement)).status, 400);

  await resetRequest(emails.owner);
  const freshToken = links[1].hash.slice('#reset-password='.length);
  assert.equal((await resetConfirm(freshToken, 'too-short')).status, 400);
  const attempts = await Promise.all([resetConfirm(freshToken, replacement), resetConfirm(freshToken, replacement)]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 400]);
  assert.equal((await request('/auth/me', { user: 'owner' })).status, 401);
  assert.equal((await request('/auth/me', { user: 'stranger' })).status, 200);
  assert.equal((await request('/auth/login', { payload: { email: emails.owner, password: fixturePassword } })).status, 401);
  assert.equal((await request('/auth/login', { payload: { email: emails.owner, password: replacement } })).status, 200);
});

test('delivers hosted reset links through email and skips reserved demo accounts', async t => {
  const background = [];
  const { request, env, database } = await withApp(t, undefined, work => background.push(work));
  env.CLIENT_ORIGIN = 'https://tickets.example.test';
  env.PASSWORD_RESET_FROM = 'TicketMaestro <support@example.test>';
  env.RESEND_API_KEY = 'test-only-token';
  database.exec("UPDATE users SET email = 'admin@admin.com' WHERE id = 'admin'");

  const sent = [];
  const actualFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (url !== 'https://api.resend.com/emails') return actualFetch(url, options);
    sent.push({ headers: options.headers, body: JSON.parse(options.body) });
    return Promise.resolve(Response.json({ id: 'synthetic-delivery' }));
  });
  const resetRequest = email => request('/auth/password-reset/request', {
    payload: { email }, requestOrigin: env.CLIENT_ORIGIN
  });
  const demo = await resetRequest('admin@admin.com');
  const registered = await resetRequest(emails.owner);
  assert.equal(registered.status, 202);
  assert.deepEqual(demo.data, registered.data);
  assert.deepEqual(registered.data, { accepted: true, delivery: 'email' });
  assert.equal(background.length, 1);
  await Promise.all(background);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.Authorization, 'Bearer test-only-token');
  assert.equal(sent[0].body.from, env.PASSWORD_RESET_FROM);
  assert.deepEqual(sent[0].body.to, [emails.owner]);
  assert.match(sent[0].body.text, /https:\/\/tickets\.example\.test\/#reset-password=[a-f0-9]{64}/);
});

test('validates requests, protects roles and never forwards invalid ticket content', async t => {
  const { request, calls, database } = await withApp(t);
  const denied = await request('/tickets', { requestOrigin: 'https://other.example.test' });
  assert.equal(denied.status, 403);
  const preflight = await request('/tickets', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.match(preflight.headers.get('access-control-allow-methods'), /PATCH/);

  const register = await request('/auth/register', {
    payload: { email: 'New.User@Example.Test', password: fixturePassword, role: 'admin' }
  });
  assert.equal(register.status, 201);
  assert.equal(register.data.user.role, 'user');
  assert.equal(register.data.user.email, 'new.user@example.test');
  const persisted = database.prepare('SELECT password_hash FROM users WHERE id = ?').get(register.data.user.id);
  assert.notEqual(persisted.password_hash, fixturePassword);
  assert.equal((await request('/auth/login', { payload: { email: emails.staff, password: 'wrong' } })).status, 401);

  const login = await request('/auth/login', { payload: { email: emails.staff, password: fixturePassword } });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, 'staff');
  assert.equal(login.data.user.department, 'technical');
  assert.equal(Object.hasOwn(login.data, 'token'), false);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /;\s*HttpOnly\b/i);
  const token = cookie.match(/ticketmaestro_session=([^;]+)/)[1];
  const me = await request('/auth/me', { token });
  assert.equal(me.data.user.role, 'staff');
  const logout = await request('/auth/logout', { token, method: 'POST' });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /ticketmaestro_session=;/);
  assert.equal((await request('/auth/me', { token })).status, 401);

  assert.equal((await request('/tickets')).status, 401);
  assert.equal((await request('/tickets', { user: 'owner', raw: '{"message"' })).status, 400);
  for (const message of ['short', 'a'.repeat(2001), null, {}]) {
    assert.equal((await request('/tickets', { user: 'owner', payload: { message } })).status, 400);
  }
  assert.equal(calls(), 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM api_usage').get().count, 0);
  assert.equal((await request('/stats', { user: 'owner' })).status, 403);
  assert.equal((await request('/admin/users', { user: 'staff' })).status, 403);
  assert.equal((await request('/admin/users', { user: 'admin' })).status, 200);
});

test('persists all queues, staff changes, manual review and separate category statistics', async t => {
  const { request, env, database, calls } = await withApp(t);
  const create = async message => {
    const result = await request('/tickets', { user: 'owner', payload: { message } });
    assert.equal(result.status, 201);
    return result.data.ticket;
  };
  const submitted = {};
  for (const sample of samples) {
    const ticket = await create(sample.message);
    assert.equal(ticket.department, sample.department);
    assert.equal(ticket.priority ?? ticket.urgency, sample.urgency);
    assert.equal(ticket.status, 'open');
    submitted[sample.department] = ticket;
  }
  const uncertain = await create('I have a service issue. Please take a look.');
  assert.equal(uncertain.department, null);
  assert.equal(uncertain.status, 'manual_review');
  env.AI_MODE = 'offline';
  const offline = await create('I need support during an offline test.');
  assert.equal(offline.status, 'manual_review');
  assert.equal(calls(), 5);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM api_usage').get().count, 6);

  const dashboard = await request('/tickets?sort=priority', { user: 'staff' });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.data.tickets[0].id, submitted.technical.id);
  assert(dashboard.data.tickets.every(ticket => ticket.email === emails.owner));
  const filter = await request('/tickets?department=unassigned&status=manual_review&q=offline', { user: 'admin' });
  assert.deepEqual(filter.data.tickets.map(ticket => ticket.id), [offline.id]);
  const byId = await request('/tickets?q=' + submitted.billing.id, { user: 'admin' });
  assert.deepEqual(byId.data.tickets.map(ticket => ticket.id), [submitted.billing.id]);
  assert.deepEqual((await request('/tickets', { user: 'stranger' })).data.tickets, []);
  const own = await request('/tickets', { user: 'owner' });
  assert.equal(own.data.submissions, 6);
  assert.equal(own.data.tickets.length, 6);
  assert(own.data.tickets.every(ticket => !Object.hasOwn(ticket, 'email')));

  const path = '/tickets/' + uncertain.id;
  const before = (await request(path, { user: 'staff' })).data.ticket;
  assert.equal(before.classification_outcome, 'low_confidence');
  assert.equal(before.jev_department, 'technical');
  assert.equal(before.jev_urgency, 'medium');
  assert.equal(before.classification_model, '@cf/cloudflare/clef-flash');
  assert.equal(before.classification_department, 'technical');
  assert.equal(before.classification_urgency, 'medium');
  assert.equal((await request('/tickets/' + offline.id, { user: 'staff' })).data.ticket.classification_outcome, 'unavailable');
  assert([403, 404].includes((await request(path, { user: 'stranger' })).status));
  assert.equal((await request(path, { user: 'owner' })).status, 200);
  assert.equal((await request(path, { user: 'owner', method: 'PATCH', payload: { status: 'closed' } })).status, 403);
  assert.equal((await request(path, { user: 'staff', method: 'PATCH', payload: { priority: 'critical' } })).status, 400);

  const updates = await Promise.all(['account', 'billing'].map(department => (
    request(path, {
      user: 'staff', method: 'PATCH', payload: { department, priority: 'high', version: before.version }
    })
  )));
  assert.deepEqual(updates.map(item => item.status).sort(), [200, 409]);
  const routed = updates.find(item => item.status === 200).data.ticket;
  assert.equal(routed.status, 'open');
  assert.equal(routed.priority, 'high');
  assert.equal(routed.jev_department, 'technical');
  assert.equal(routed.version, before.version + 1);

  const edit = await request(path, {
    user: 'admin', method: 'PATCH',
    payload: { status: 'resolved', department: 'general', priority: 'low', version: routed.version }
  });
  assert.equal(edit.status, 200);
  const ownerTicket = (await request(path, { user: 'owner' })).data.ticket;
  assert.equal(ownerTicket.department, 'general');
  assert.equal(ownerTicket.status, 'resolved');
  assert.equal(ownerTicket.priority, 'low');
  const stats = await request('/stats', { user: 'staff' });
  assert.equal(stats.status, 200);
  assert.equal(stats.data.total, 6);
  assert.equal(stats.data.byDepartment.general, 2);
  assert.equal(stats.data.byCategory.general, 1);
  assert.equal(stats.data.byStatus.resolved, 1);
  assert.equal(stats.data.byPriority.low, 2);
});

test('preserves previously routed tickets and paginates without duplicates', async t => {
  const ids = Array.from({ length: 65 }, () => randomUUID());
  const { request } = await withApp(t, database => {
    const legacy = database.prepare(`
      INSERT INTO tickets (id, user_id, message, department, urgency, confidence, status)
      VALUES (?, 'owner', 'Previously routed internet issue', 'technical', 'high', 0.91, 'open')
    `);
    for (const id of ids) legacy.run(id);
  });
  const legacy = (await request('/tickets/' + ids[0], { user: 'staff' })).data.ticket;
  assert.equal(legacy.jev_department, 'technical');
  assert.equal(legacy.jev_urgency, 'high');
  assert.equal(legacy.classification_model, 'typesafe/jev');
  assert.equal(legacy.classification_outcome, 'classified');
  const all = [];
  let after = null;
  do {
    const search = new URLSearchParams({ department: 'technical', sort: 'priority' });
    if (after) search.set('after', after);
    const result = await request('/tickets?' + search, { user: 'admin' });
    assert.equal(result.status, 200);
    all.push(...result.data.tickets.map(ticket => ticket.id));
    assert(all.length <= ids.length);
    after = result.data.next;
  } while (after);
  assert.deepEqual(new Set(all), new Set(ids));
});

test('rejects a future version even if another writer reaches it before the update', { timeout: 5000 }, async t => {
  const { request, controls } = await withApp(t);
  const submitted = await request('/tickets', {
    user: 'owner', payload: { message: samples[0].message }
  });
  assert.equal(submitted.status, 201);
  const path = '/tickets/' + submitted.data.ticket.id;
  const { version } = (await request(path, { user: 'staff' })).data.ticket;
  const read = Promise.withResolvers();
  const resume = Promise.withResolvers();
  controls.onRead = row => {
    if (row?.id !== submitted.data.ticket.id) return;
    delete controls.onRead;
    read.resolve();
    return resume.promise;
  };
  const future = request(path, {
    user: 'staff', method: 'PATCH', payload: { priority: 'low', version: version + 1 }
  });
  try {
    await read.promise;
    const concurrent = await request(path, {
      user: 'admin', method: 'PATCH', payload: { department: 'account', version }
    });
    assert.equal(concurrent.status, 200);
  } finally {
    resume.resolve();
  }
  assert.equal((await future).status, 409);
  const ticket = (await request(path, { user: 'staff' })).data.ticket;
  assert.equal(ticket.department, 'account');
  assert.equal(ticket.priority, 'high');
  assert.equal(ticket.version, version + 1);
});

test('only administrators can delete tickets and accounts, and deletions update related data', async t => {
  const { request, database } = await withApp(t);
  const submit = async user => {
    const created = await request('/tickets', { user, payload: { message: samples[0].message } });
    assert.equal(created.status, 201);
    return created.data.ticket.id;
  };
  const ticket = await submit('owner');
  const staffTicket = await submit('staff');
  const survivingTicket = await submit('stranger');
  const ticketPath = '/admin/tickets/' + ticket;
  const userPath = '/admin/users/staff';
  const remove = (path, user) => request(path, { user, method: 'DELETE' });
  for (const path of [ticketPath, userPath]) {
    const preflight = await request(path, { method: 'OPTIONS' });
    assert.match(preflight.headers.get('access-control-allow-methods'), /\bDELETE\b/);
    assert.equal((await remove(path)).status, 401);
    assert.equal((await remove(path, 'owner')).status, 403);
    assert.equal((await remove(path, 'staff')).status, 403);
  }
  assert.equal((await remove('/admin/users/admin', 'admin')).status, 409);

  const removedTicket = await remove(ticketPath, 'admin');
  assert.equal(removedTicket.status, 200);
  assert.deepEqual(removedTicket.data, { deleted: true });
  assert.equal((await remove(ticketPath, 'admin')).status, 404);
  assert.equal((await request('/tickets/' + ticket, { user: 'owner' })).status, 404);
  const customer = await request('/tickets', { user: 'owner' });
  assert.deepEqual(customer.data.tickets, []);
  assert.equal(customer.data.submissions, 1);

  database.prepare("INSERT INTO password_resets(token_hash, user_id, expires_at) VALUES ('pending', 'staff', unixepoch() + 1800)").run();
  const removedUser = await remove(userPath, 'admin');
  assert.equal(removedUser.status, 200);
  assert.deepEqual(removedUser.data, { deleted: true });
  assert.equal((await remove(userPath, 'admin')).status, 404);
  assert.equal((await request('/auth/me', { user: 'staff' })).status, 401);
  assert.equal((await request('/tickets/' + staffTicket, { user: 'admin' })).status, 404);
  for (const table of ['sessions', 'password_resets', 'staff_profiles', 'api_usage', 'api_requests']) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = 'staff'`).get().count, 0);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM api_requests WHERE route = '/api/v1/tickets' AND method = 'POST' AND user_id IS NULL").get().count, 1);
  const users = await request('/admin/users', { user: 'admin' });
  assert.equal(users.data.users.some(user => user.id === 'staff'), false);
  assert.deepEqual(users.data.totals, { users: 3, submissions: 2 });
  assert.equal((await request('/stats', { user: 'admin' })).data.total, 1);
  assert.equal((await request('/tickets/' + survivingTicket, { user: 'stranger' })).status, 200);
});

test('two administrators trying to delete each other leave one active administrator', { timeout: 5000 }, async t => {
  const { request, database, controls } = await withApp(t);
  database.prepare("UPDATE users SET role = 'admin' WHERE id = 'stranger'").run();
  let authenticated = 0;
  let release;
  const bothAuthenticated = new Promise(resolve => { release = resolve; });
  controls.onRead = async row => {
    if (row?.role === 'admin' && row?.email) {
      if (++authenticated === 2) release();
      await bothAuthenticated;
    }
  };
  const responses = await Promise.all([
    request('/admin/users/admin', { user: 'stranger', method: 'DELETE' }),
    request('/admin/users/stranger', { user: 'admin', method: 'DELETE' })
  ]);
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 401]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM api_requests WHERE method = 'DELETE'").get().count, 2);
});

test('tracks API responses once with safe route names and restricts the report to admins', async t => {
  const { request, database } = await withApp(t);
  assert.equal((await request('/tickets', { method: 'OPTIONS' })).status, 204);
  assert.equal((await request('/admin/usage')).status, 401);
  assert.equal((await request('/admin/usage', { user: 'owner' })).status, 403);
  assert.equal((await request('/admin/usage', { user: 'staff' })).status, 403);
  assert.equal((await request('/auth/login', {
    payload: { email: emails.owner, password: 'private-input' }
  })).status, 401);
  assert.equal((await request('/auth/login', {
    payload: { email: emails.owner, password: fixturePassword }
  })).status, 200);
  const created = await request('/tickets', { user: 'owner', payload: { message: samples[0].message } });
  assert.equal(created.status, 201);
  assert.equal((await request('/tickets/' + created.data.ticket.id + '?q=private-query', { user: 'owner' })).status, 200);
  assert.equal((await request('/tickets/' + randomUUID(), { user: 'owner' })).status, 404);
  assert.equal((await request('/private-unknown-path?search=private-query')).status, 404);
  assert.equal((await request('/auth/register', {
    payload: { email: 'new@example.test', password: fixturePassword }
  })).status, 201);

  const report = await request('/admin/usage', { user: 'admin' });
  assert.equal(report.status, 200);
  const { summary, endpoints, users, daily } = report.data;
  assert.equal(summary.requests, 10);
  assert.equal(summary.errors, 6);
  assert.equal(summary.activeUsers, 3);
  assert(Number.isFinite(summary.avgDurationMs) && summary.avgDurationMs >= 0);
  assert.equal(daily.reduce((sum, day) => sum + day.requests, 0), summary.requests);
  assert.equal(daily.reduce((sum, day) => sum + day.errors, 0), summary.errors);
  assert.equal(endpoints.reduce((sum, endpoint) => sum + endpoint.requests, 0), summary.requests);
  const details = endpoints.find(item => item.method === 'GET' && item.route === '/api/v1/tickets/:id');
  assert.equal(details.requests, 2);
  assert.equal(details.errors, 1);
  const customer = users.find(item => item.email === emails.owner);
  assert.equal(customer.requests, 5);
  assert.equal(customer.errors, 2);
  assert.equal(users.find(item => item.email === 'new@example.test').requests, 1);
  const saved = database.prepare('SELECT * FROM api_requests').all();
  assert.equal(saved.length, summary.requests + 1);
  assert(!saved.some(row => row.method === 'OPTIONS'));
  const serialized = JSON.stringify(saved);
  for (const privateValue of [created.data.ticket.id, 'private-query', 'private-unknown-path', 'private-input', fixturePassword, samples[0].message]) {
    assert(!serialized.includes(privateValue));
  }
  assert.equal((await request('/tickets', { user: 'owner' })).data.submissions, 1);
  assert.equal((await request('/admin/users', { user: 'admin' })).data.totals.submissions, 1);
});

test('reports UTC windows with empty days, preserves old submissions and averages only measured durations', async t => {
  const { request, database } = await withApp(t, db => {
    db.exec(`
      INSERT INTO api_usage (user_id, endpoint, outcome, created_at) VALUES
        ('owner', 'POST /api/tickets', 'classified', date('now', '-6 days')),
        ('owner', 'POST /api/tickets', 'unavailable', date('now', '-7 days')),
        ('owner', 'POST /api/tickets', 'classified', date('now', '-90 days'))
    `);
  });
  database.exec(`
    INSERT INTO api_requests (user_id, method, route, status_code, duration_ms, created_at) VALUES
      ('staff', 'GET', '/api/v1/stats', 200, 20, datetime('now', '-2 days')),
      ('staff', 'GET', '/api/v1/stats', 500, 40, datetime('now', '-2 days'))
  `);
  const today = database.prepare("SELECT date('now') AS today, date('now', '-6 days') AS start").get();
  const seven = await request('/admin/usage', { user: 'admin' });
  assert.equal(seven.status, 200);
  assert.equal(seven.data.days, 7);
  assert.equal(seven.data.from, today.start);
  assert.equal(seven.data.to, today.today);
  assert.equal(seven.data.summary.requests, 3);
  assert.equal(seven.data.summary.errors, 1);
  assert.equal(seven.data.summary.activeUsers, 2);
  assert.equal(seven.data.userTotals.find(row => row.email === emails.owner).requests, 3);
  assert.equal(seven.data.summary.avgDurationMs, 30);
  assert.equal(seven.data.daily.length, 7);
  assert.deepEqual(seven.data.daily.map(row => row.requests), [1, 0, 0, 0, 2, 0, 0]);
  assert.equal(seven.data.daily[0].date, today.start);
  assert.equal(seven.data.daily.at(-1).date, today.today);
  assert.equal(seven.data.endpoints.find(row => row.method === 'POST').avgDurationMs, null);
  for (const days of [30, 90]) {
    const range = await request('/admin/usage?days=' + days, { user: 'admin' });
    assert.equal(range.status, 200);
    assert.equal(range.data.daily.length, days);
    assert.equal(range.data.endpoints.find(row => row.route === '/api/v1/tickets').requests, 2);
    assert.equal(range.data.daily.reduce((sum, row) => sum + row.requests, 0), range.data.summary.requests);
  }
  for (const query of ['0', '365', 'seven', '7&days=30']) {
    assert.equal((await request('/admin/usage?days=' + query, { user: 'admin' })).status, 400);
  }
});

test('a reporting write failure still delivers the successfully submitted ticket', async t => {
  const { request, database } = await withApp(t);
  const log = t.mock.method(console, 'error', () => {});
  database.exec(`
    CREATE TRIGGER interrupt_usage BEFORE INSERT ON api_requests
    BEGIN SELECT RAISE(FAIL, 'unavailable for this test'); END;
  `);
  const result = await request('/tickets', { user: 'owner', payload: { message: samples[0].message } });
  assert.equal(result.status, 201);
  assert.equal(database.prepare('SELECT id FROM tickets').get().id, result.data.ticket.id);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM api_usage').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM api_requests').get().count, 0);
  assert.equal(log.mock.callCount(), 1);
});

test('the first report on a fresh database has an empty, zero-filled range', async t => {
  const { request } = await withApp(t);
  const response = await request('/admin/usage?days=30', { user: 'admin' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.summary, { requests: 0, errors: 0, activeUsers: 0, avgDurationMs: null });
  assert.deepEqual(response.data.endpoints, []);
  assert.deepEqual(response.data.users, []);
  assert.equal(response.data.endpointTotals.length, 17);
  assert(response.data.endpointTotals.every(row => row.requests === 0 && row.errors === 0));
  assert.equal(response.data.daily.length, 30);
  assert(response.data.daily.every(day => day.requests === 0 && day.errors === 0));
});

test('counts concurrent functional calls once, warns after 20 and preserves the allowance across sign-ins', async t => {
  const { request } = await withApp(t);
  const used = response => Number(response.headers.get('x-api-calls-used'));
  const credentials = { email: emails.owner, password: fixturePassword };
  const login = await request('/auth/login', { payload: credentials });
  assert.equal(login.headers.get('x-api-calls-used'), '0');
  assert.equal(login.headers.get('x-api-free-limit'), '20');
  await request('/tickets', { method: 'OPTIONS' });
  await request('/auth/logout', { method: 'POST', token: login.headers.get('set-cookie').match(/ticketmaestro_session=([^;]+)/)[1] });
  const reads = await Promise.all(Array.from({ length: 20 }, () => request('/tickets', { user: 'owner' })));
  assert(reads.every(r => r.status === 200 && r.headers.get('x-api-free-exceeded') === 'false'));
  assert(reads.every(r => r.data.usage === used(r) && r.data.submissions === 0));
  assert.deepEqual(reads.map(used).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  const create = await request('/tickets', { user: 'owner', payload: { message: samples[0].message } });
  assert.equal(create.status, 201);
  assert.equal(used(create), 21);
  assert.equal(create.headers.get('x-api-free-exceeded'), 'true');
  assert.equal(create.data.ticket.status, 'open');
  const nextLogin = await request('/auth/login', { payload: credentials });
  assert.equal(used(nextLogin), 21);
  const report = await request('/admin/usage', { user: 'admin' });
  const total = name => report.data.userTotals.find(row => row.email === emails[name]).requests;
  assert.equal(total('owner'), 21);
  assert.equal(total('stranger'), 0);
  assert.equal(total('admin'), 1);
  const endpoint = (method, route) => report.data.endpointTotals.find(row => row.method === method && row.route === route);
  assert.equal(endpoint('GET', '/api/v1/tickets').requests, 20);
  assert.equal(endpoint('POST', '/api/v1/auth/login').requests, 2);
  assert.equal(endpoint('DELETE', '/api/v1/admin/tickets/:id').requests, 0);
});
