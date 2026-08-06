#!/usr/bin/env node
/**
 * One-off script to fix phone numbers missing a leading zero.
 * Usage:
 * 1) Dry run: `node scripts/fix_phone_leading_zero.js --dry-run`
 *    Shows how many records would be changed and sample rows.
 * 2) Apply: `node scripts/fix_phone_leading_zero.js`
 *
 * Safety checks:
 * - Only targets `phone` and `parent_phone` that are exactly 10 digits and do NOT start with '0'.
 * - Skips any value containing non-digits or already starting with '0' or '+'.
 * - Runs updates inside a transaction.
 */

const sequelize = require('../config/database');
const Student = require('../models/Student');

function needsFix(value) {
  if (!value) return false;
  if (typeof value !== 'string') value = String(value);
  // only digits, exactly 10 chars, and does not start with 0
  return /^[0-9]{10}$/.test(value) && !value.startsWith('0');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  await sequelize.authenticate();
  console.log('Connected to DB');

  const students = await Student.findAll({ attributes: ['id', 'phone', 'parent_phone'] });
  const toUpdate = [];

  for (const s of students) {
    const phone = s.phone ? String(s.phone).trim() : '';
    const parent = s.parent_phone ? String(s.parent_phone).trim() : '';
    const fix = {};
    if (needsFix(phone)) fix.phone = '0' + phone;
    if (needsFix(parent)) fix.parent_phone = '0' + parent;
    if (Object.keys(fix).length > 0) toUpdate.push({ id: s.id, before: { phone, parent_phone: parent }, after: fix });
  }

  console.log(`Found ${toUpdate.length} student(s) with phone fields that match the fix criteria.`);
  if (toUpdate.length === 0) {
    console.log('No changes required. Exiting.');
    process.exit(0);
  }

  const sample = toUpdate.slice(0, 10);
  console.log('Sample changes (first 10):');
  for (const r of sample) console.log(r);

  if (dryRun) {
    console.log('Dry run requested — no database changes will be made. Review sample above.');
    process.exit(0);
  }

  // Confirm with the user
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question('Proceed to apply these changes? Type YES to continue: ', res));
  rl.close();
  if (answer !== 'YES') {
    console.log('Aborted by user. No changes applied.');
    process.exit(0);
  }

  // Apply updates in a transaction
  const t = await sequelize.transaction();
  try {
    for (const row of toUpdate) {
      const s = await Student.findByPk(row.id, { transaction: t });
      if (!s) continue;
      const payload = {};
      if (row.after.phone) payload.phone = row.after.phone;
      if (row.after.parent_phone) payload.parent_phone = row.after.parent_phone;
      await s.update(payload, { transaction: t });
    }
    await t.commit();
    console.log(`Applied changes to ${toUpdate.length} student(s).`);
  } catch (err) {
    await t.rollback();
    console.error('Error applying changes — transaction rolled back:', err);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
