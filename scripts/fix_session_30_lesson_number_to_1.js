#!/usr/bin/env node
/**
 * One-off fix: change only session id 30's lesson number from 2 to 1.
 *
 * Usage:
 *   node scripts/fix_session_30_lesson_number_to_1.js
 *   node scripts/fix_session_30_lesson_number_to_1.js --apply
 */

require('dotenv').config();
const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');

const SESSION_ID = 30;
const EXPECTED_LESSON_NUMBER = 2;
const NEW_LESSON_NUMBER = 1;
const EXPECTED_SERIAL_NUMBER = 1001;

async function main() {
  const apply = process.argv.includes('--apply');
  let transaction;

  try {
    await sequelize.authenticate();

    if (!apply) {
      const rows = await sequelize.query(
        'SELECT id, lesson_number, serial_number, CenterId, SubjectId FROM sessions WHERE id = :sessionId',
        { replacements: { sessionId: SESSION_ID }, type: QueryTypes.SELECT },
      );
      console.log(rows);
      console.log('Read-only check complete. No changes were made. Use --apply only after reviewing this output.');
      return;
    }

    transaction = await sequelize.transaction();
    const rows = await sequelize.query(
      'SELECT id, lesson_number, serial_number FROM sessions WHERE id = :sessionId FOR UPDATE',
      {
        replacements: { sessionId: SESSION_ID },
        type: QueryTypes.SELECT,
        transaction,
      },
    );

    if (rows.length !== 1) {
      throw new Error(`Safety check failed: expected session id ${SESSION_ID}, found ${rows.length} rows.`);
    }
    if (rows[0].lesson_number !== EXPECTED_LESSON_NUMBER || rows[0].serial_number !== EXPECTED_SERIAL_NUMBER) {
      throw new Error(
        `Safety check failed: expected lesson_number ${EXPECTED_LESSON_NUMBER} and serial_number ${EXPECTED_SERIAL_NUMBER}, `
        + `found lesson_number ${rows[0].lesson_number} and serial_number ${rows[0].serial_number}.`,
      );
    }

    await sequelize.query(
      'UPDATE sessions SET lesson_number = :newLessonNumber WHERE id = :sessionId AND lesson_number = :expectedLessonNumber AND serial_number = :expectedSerialNumber',
      {
        replacements: {
          newLessonNumber: NEW_LESSON_NUMBER,
          sessionId: SESSION_ID,
          expectedLessonNumber: EXPECTED_LESSON_NUMBER,
          expectedSerialNumber: EXPECTED_SERIAL_NUMBER,
        },
        type: QueryTypes.UPDATE,
        transaction,
      },
    );

    const updatedRows = await sequelize.query(
      'SELECT id, lesson_number, serial_number FROM sessions WHERE id = :sessionId',
      {
        replacements: { sessionId: SESSION_ID },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    if (updatedRows.length !== 1 || updatedRows[0].lesson_number !== NEW_LESSON_NUMBER) {
      throw new Error('Safety check failed: the lesson number could not be verified after the update.');
    }

    await transaction.commit();
    transaction = null;
    console.log(`Updated session id ${SESSION_ID}: lesson_number ${EXPECTED_LESSON_NUMBER} -> ${NEW_LESSON_NUMBER}.`);
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
