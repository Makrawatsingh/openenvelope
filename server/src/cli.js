import { config } from './config.js';
import { openDb, q } from './db.js';
import { newId, hashKey, now } from './util.js';

const [cmd, email, name] = process.argv.slice(2);
if (cmd !== 'create-user' || !email) {
  console.log('usage: npm run create-user -- you@example.com "Your Name"');
  process.exit(1);
}
const db = q(openDb(config.dbPath));
const key = 'oe_' + newId(24);
const existing = db.get('SELECT id FROM users WHERE email=?', email);
if (existing) {
  db.run('UPDATE users SET api_key_hash=? WHERE id=?', hashKey(key), existing.id);
  console.log(`Rotated API key for ${email}`);
} else {
  const admin = db.get('SELECT COUNT(*) n FROM users').n === 0 ? 1 : 0;
  db.run('INSERT INTO users (id,email,name,api_key_hash,is_admin,created_at) VALUES (?,?,?,?,?,?)', newId(), email, name || null, hashKey(key), admin, now());
  console.log(`Created user ${email}${admin ? ' (admin)' : ''}`);
}
console.log(`API key (shown once, paste it into the extension settings):\n${key}`);
