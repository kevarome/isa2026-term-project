import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { createApp } from '../src/app.js';
import { sessionCookieOptions, signSession, verifySession } from '../src/session.js';

const secret = randomBytes(32).toString('base64url');
const clientOrigin = 'https://portal.example.test';

test('issues unique signed sessions for the API and rejects a different signing key', async () => {
  const token = await signSession('customer-1', secret);
  const { iss, aud, sub, iat, exp } = decodeJwt(token);
  assert.equal(decodeProtectedHeader(token).alg, 'HS256');
  assert.equal(iss, 'ticketmaestro');
  assert.equal(aud, 'ticketmaestro-api');
  assert.equal(sub, 'customer-1');
  assert.equal(exp - iat, 8 * 60 * 60);
  assert.equal(await verifySession(token, secret), sub);
  assert.notEqual(await signSession(sub, secret), token);
  assert.equal(await verifySession(token, randomBytes(32).toString('base64url')), null);
  await assert.rejects(async () => signSession(sub, 'short'));
});

test('rejects a session as soon as its signed expiration is reached', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00Z') });
  const token = await signSession('customer-2', secret);
  const expiresAt = decodeJwt(token).exp * 1000;
  t.mock.timers.setTime(expiresAt - 1);
  assert.equal(await verifySession(token, secret), 'customer-2');
  t.mock.timers.setTime(expiresAt);
  assert.equal(await verifySession(token, secret), null);
});

test('restricts cookie access to the API and supports separate HTTPS sites', () => {
  for (const [origin, secure, sameSite] of [
    [clientOrigin, true, 'none'],
    ['http://localhost:8788', false, 'lax']
  ]) {
    const cookie = sessionCookieOptions(origin);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.path, '/api');
    assert.equal(cookie.secure, secure);
    assert.equal(cookie.sameSite.toLowerCase(), sameSite);
    assert.equal(cookie.domain, undefined);
  }
});

test('grants credentialed CORS preflights to the configured client origin only', async t => {
  const server = createApp({ CLIENT_ORIGIN: clientOrigin, JWT_SECRET: secret }).listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/api/tickets';
  const preflight = origin => fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'PATCH',
      'Access-Control-Request-Headers': 'content-type'
    }
  });
  const allowed = await preflight(clientOrigin);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), clientOrigin);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
  assert.match(allowed.headers.get('vary'), /Origin/i);
  assert.match(allowed.headers.get('access-control-allow-methods'), /PATCH/);
  assert.match(allowed.headers.get('access-control-allow-headers'), /Content-Type/i);

  const denied = await preflight('https://other.example.test');
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const apiHost = new URL(url).host;
  assert.equal((await preflight('https://' + apiHost)).status, 204);
  assert.equal((await preflight('http://' + apiHost)).status, 403);
});
