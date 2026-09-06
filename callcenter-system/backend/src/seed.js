require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, initSchema } = require('./db');

const username = process.env.ADMIN_USERNAME || 'admin';
const password = process.env.ADMIN_PASSWORD || 'changeme123';
const name = process.env.ADMIN_NAME || 'Administrator';

(async () => {
  await initSchema();

  const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
  if (existing.length) {
    console.log(`User "${username}" already exists. Nothing to do.`);
    process.exit(0);
  }

  const hash = bcrypt.hashSync(password, 10);
  await pool.query(
    'INSERT INTO users (username, password_hash, name, role, active) VALUES (?, ?, ?, ?, 1)',
    [username, hash, name, 'admin']
  );

  console.log(`Admin account created: username="${username}" password="${password}"`);
  console.log('Log in and change this password by creating a new admin user if needed.');
  process.exit(0);
})().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
