import { hashPassword } from '../src/password.js';

for (const [email, password, role] of [
  ['john@john.com', '123', 'user'],
  ['admin@admin.com', '111', 'admin']
]) {
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  console.log(`INSERT INTO users (id, email, password_hash, role) VALUES ('${id}', '${email}', '${hash}', '${role}');`);
}
