import { SignJWT, jwtVerify } from 'jose';

export const sessionCookieName = 'ticketmaestro_session';
export const sessionSeconds = 8 * 60 * 60;
const issuer = 'ticketmaestro';
const audience = 'ticketmaestro-api';

function signingKey(secret) {
  const bytes = typeof secret === 'string' && new TextEncoder().encode(secret);
  if (!bytes || bytes.length < 32) throw new Error('Configure JWT_SECRET with at least 32 bytes.');
  return bytes;
}

export function signSession(userId, secret) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + sessionSeconds)
    .sign(signingKey(secret));
}

export async function verifySession(token, secret) {
  if (!token || token.length > 4096) return null;
  const key = signingKey(secret);
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'], issuer, audience, typ: 'JWT',
      requiredClaims: ['sub', 'iat', 'jti', 'exp']
    });
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

export function sessionCookieOptions(clientOrigin) {
  const client = new URL(clientOrigin);
  const localHttp = client.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(client.hostname);
  return { path: '/api', httpOnly: true, secure: !localHttp, sameSite: localHttp ? 'lax' : 'none' };
}
