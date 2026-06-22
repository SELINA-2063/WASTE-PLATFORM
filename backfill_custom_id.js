// Run this ONCE after the migration, to assign custom_id to users that
// already existed in your database before this feature was added.
// Usage: node backfill_custom_id.js

const db = require('./db');

const prefixMap = {
  admin: 'AD',
  buyer: 'B',
  seller: 'S'
};

db.query('SELECT id, role FROM users ORDER BY id ASC', (err, users) => {
  if (err) {
    console.error('Failed to fetch users:', err);
    process.exit(1);
  }

  const counters = { admin: 0, buyer: 0, seller: 0 };
  let pending = users.length;

  if (pending === 0) {
    console.log('No users found.');
    process.exit(0);
  }

  users.forEach((u) => {
    const role = (u.role || 'buyer').toLowerCase();
    const prefix = prefixMap[role] || 'B';

    counters[role] = (counters[role] || 0) + 1;
    const padded = String(counters[role]).padStart(2, '0');
    const customId = `${prefix}-${padded}`;

    db.query(
      'UPDATE users SET custom_id = ? WHERE id = ?',
      [customId, u.id],
      (updateErr) => {
        pending -= 1;
        if (updateErr) {
          console.error(`Failed for user id ${u.id}:`, updateErr.message);
        } else {
          console.log(`User id ${u.id} (${role}) -> ${customId}`);
        }

        if (pending === 0) {
          console.log('Backfill complete.');
          process.exit(0);
        }
      }
    );
  });
});