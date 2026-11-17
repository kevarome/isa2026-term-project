import { hashPassword } from '../src/password.js';

function quote(value) {
  return value === null ? 'NULL' : "'" + value.replaceAll("'", "''") + "'";
}

function demoPassword(name, fallback) {
  const value = process.env['TICKETMAESTRO_DEMO_' + name + '_PASSWORD'];
  if (value === undefined) return fallback;
  if (value.length < 12 || value.length > 128) {
    throw new Error(`The ${name.toLowerCase()} demo password override must be 12 to 128 characters.`);
  }
  return value;
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--tickets')) {
  console.error('Usage: node scripts/demo-sql.js [--tickets]');
  process.exit(1);
}

const customerEmail = 'john@john.com';
const staffPassword = demoPassword('STAFF', 'NorthLink-demo-only-Workshop42!');
const departments = ['billing', 'technical', 'account', 'general'];
const accounts = [
  { email: customerEmail, password: demoPassword('CUSTOMER', '123'), role: 'user' },
  { email: 'admin@admin.com', password: demoPassword('ADMIN', '111'), role: 'admin' },
  ...departments.map(department => ({ email: department + '@example.test', password: staffPassword, role: 'user', department }))
];

const sql = ['-- Synthetic TicketMaestro demo data'];
for (const [index, { email, password, role, department }] of accounts.entries()) {
  const id = 'dc06a4fe-47a0-4a0b-94d3-46c27aa8290' + (index + 1);
  const hash = await hashPassword(password);
  sql.push(
    'INSERT INTO users (id, email, password_hash, role) VALUES (' +
    [id, email, hash, role].map(quote).join(', ') + ') ON CONFLICT DO NOTHING;'
  );
  if (department) {
    // Match the reserved seed ID before granting staff access.
    sql.push(
      'INSERT INTO staff_profiles (user_id, department) ' +
      `SELECT id, ${quote(department)} FROM users WHERE id = ${quote(id)} AND email = ${quote(email)} AND role = 'user' ` +
      'ON CONFLICT(user_id) DO NOTHING;'
    );
  }
}

if (args[0] === '--tickets') {
  const examples = [
    ['My internet has been down since this morning, and I need the connection to work from home.', 'technical', 'high', 'open'],
    ['The same charge appears twice on my fictional monthly bill.', 'billing', 'medium', 'in_progress'],
    ["I couldn't sign in, and the password reset message didn't arrive.", 'account', 'medium', 'closed'],
    ['Which home internet plans are available for a new customer?', 'general', 'low', 'resolved'],
    ['Can someone help with the problem I mentioned earlier?', null, null, 'manual_review']
  ];
  for (const [index, [message, department, priority, status]] of examples.entries()) {
    const id = 'e763f504-2059-4dc5-b7f7-67f3d760bb0' + (index + 1);
    sql.push(
      'INSERT INTO tickets (id, user_id, message, department, urgency, status, classification_outcome, updated_at) ' +
      `SELECT ${quote(id)}, id, ${[message, department, priority, status, 'seeded'].map(quote).join(', ')}, CURRENT_TIMESTAMP ` +
      `FROM users WHERE email = ${quote(customerEmail)} AND role = 'user' ON CONFLICT(id) DO NOTHING;`
    );
  }
}

console.log(sql.join('\n'));
