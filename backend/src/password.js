import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password, salt = crypto.randomUUID()) {
  const key = await derive(password, salt, 64, options);
  return salt + ':' + key.toString('hex');
}

export async function verifyPassword(password, stored) {
  const candidate = await hashPassword(password, stored.split(':')[0]);
  const expected = Buffer.from(stored);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
