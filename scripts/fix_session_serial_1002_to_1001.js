#!/usr/bin/env node
/**
 * One-off fix: change exactly one session serial number from 1002 to 1001.
 *
 * Usage:
 *   node scripts/fix_session_serial_1002_to_1001.js
 *   node scripts/fix_session_serial_1002_to_1001.js --apply
 *
 * The default mode is a read-only check. The --apply mode updates only
 * sessions.serial_number inside a transaction.
 */

require('dotenv').config();
const sequelize = require('../config/database');
const Session = require('../models/Session');

const OLD_SERIAL_NUMBER = 1002;
const NEW_SERIAL_NUMBER = 1001;

async function main() {
  const apply = process.argv.includes('--apply');
  let transaction;

  try {
    await sequelize.authenticate();

    if (!apply) {
      const candidates = await Session.findAll({
        attributes: ['id', 'serial_number', 'lesson_number', 'session_date', 'CenterId', 'SubjectId'],
        where: { serial_number: OLD_SERIAL_NUMBER },
      });
      const existingTarget = await Session.count({
        where: { serial_number: NEW_SERIAL_NUMBER },
      });

      console.log(`Found ${candidates.length} session(s) with serial_number ${OLD_SERIAL_NUMBER}.`);
      console.log(`Found ${existingTarget} session(s) with serial_number ${NEW_SERIAL_NUMBER}.`);
      console.log(candidates);
      console.log('Read-only check complete. No changes were made. Use --apply only after reviewing this output.');
      return;
    }

    transaction = await sequelize.transaction();

    const candidates = await Session.findAll({
      attributes: ['id', 'serial_number', 'lesson_number', 'session_date', 'CenterId', 'SubjectId'],
      where: { serial_number: OLD_SERIAL_NUMBER },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const existingTarget = await Session.count({
      where: { serial_number: NEW_SERIAL_NUMBER },
      transaction,
    });

    if (candidates.length !== 1) {
      throw new Error(`Safety check failed: expected exactly one session with serial_number ${OLD_SERIAL_NUMBER}, found ${candidates.length}.`);
    }
    if (existingTarget !== 0) {
      throw new Error(`Safety check failed: serial_number ${NEW_SERIAL_NUMBER} already exists on ${existingTarget} session(s).`);
    }

    const session = candidates[0];
    await Session.update(
      { serial_number: NEW_SERIAL_NUMBER },
      { where: { id: session.id, serial_number: OLD_SERIAL_NUMBER }, transaction },
    );

    const updated = await Session.findOne({
      attributes: ['id', 'serial_number'],
      where: { id: session.id },
      transaction,
    });
    if (!updated || updated.serial_number !== NEW_SERIAL_NUMBER) {
      throw new Error('Safety check failed: the serial number could not be verified after the update.');
    }

    await transaction.commit();
    transaction = null;
    console.log(`Updated session id ${session.id}: serial_number ${OLD_SERIAL_NUMBER} -> ${NEW_SERIAL_NUMBER}.`);
    console.log('No other session fields or related records were changed.');
  } catch (error) {
    if (transaction) await transaction.rollback();
    console.error(`Failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

main();
