import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

// Derive a 64-byte password hash with scrypt and encode it as salt:hex.
// Generate a fresh random salt when setting a password. Verification supplies the stored salt.
export async function hashPassword(password, salt = crypto.randomUUID()) {
  const key = await derive(password, salt, 64, options);
  return salt + ':' + key.toString('hex');
}

// Hash the submitted password with the salt embedded in the stored value.
// Check that the buffers have equal lengths before comparing their contents with timingSafeEqual.
export async function verifyPassword(password, stored) {
  const candidate = await hashPassword(password, stored.split(':')[0]);
  const expected = Buffer.from(stored);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
