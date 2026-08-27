#!/usr/bin/env node
/**
 * One-off operation: mark homework as complete for attended students in one session.
 *
 * Preview:
 *   node scripts/mark_session_homework_complete.js 1002
 * Apply after reviewing the preview:
 *   node scripts/mark_session_homework_complete.js 1002 --apply --confirm
 */

require('dotenv').config();
const sequelize = require('../config/database');
require('../models/associations')();

const Session = require('../models/Session');
const Attendance = require('../models/Attendance');
const HomeworkCheck = require('../models/HomeworkCheck');
const Student = require('../models/Student');

const serialArgument = process.argv.find(argument => /^\d+$/.test(argument));
const targetSerial = serialArgument ? Number(serialArgument) : null;
const apply = process.argv.includes('--apply');
const confirm = process.argv.includes('--confirm');

if (!targetSerial) {
  console.error('Usage: node scripts/mark_session_homework_complete.js <session-serial> [--apply --confirm]');
  process.exitCode = 1;
}

async function findTarget(transaction = null) {
  const sessions = await Session.findAll({
    where: { serial_number: targetSerial },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (sessions.length !== 1) {
    throw new Error(`Safety check failed: expected exactly one session with serial_number ${targetSerial}, found ${sessions.length}.`);
  }
  return sessions[0];
}

async function loadScope(session, transaction = null) {
  const attendances = await Attendance.findAll({
    where: { SessionId: session.id },
    transaction,
  });
  const studentIds = [...new Set(attendances.map(attendance => attendance.StudentId))];
  const existingChecks = studentIds.length
    ? await HomeworkCheck.findAll({ where: { SessionId: session.id, StudentId: studentIds }, transaction })
    : [];
  const students = studentIds.length
    ? await Student.findAll({ where: { id: studentIds }, attributes: ['id', 'name', 'student_code'], transaction })
    : [];

  return { attendances, existingChecks, students };
}

function printPreview(session, scope) {
  const existingByStudent = new Map(scope.existingChecks.map(check => [check.StudentId, check]));
  const missingCount = scope.attendances.filter(attendance => !existingByStudent.has(attendance.StudentId)).length;
  const updateCount = scope.existingChecks.filter(check => check.status !== 'complete').length;

  console.log(`Target session: id=${session.id}, serial_number=${session.serial_number}, lesson_number=${session.lesson_number}`);
  console.log(`Attended students: ${scope.attendances.length}`);
  console.log(`Existing homework checks: ${scope.existingChecks.length}`);
  console.log(`Existing checks to set complete: ${updateCount}`);
  console.log(`Missing checks to create as complete: ${missingCount}`);
  console.log('\nNo points, balances, attendance records, submissions, or absent students will be changed.');

  for (const attendance of scope.attendances) {
    const student = scope.students.find(row => row.id === attendance.StudentId);
    const check = existingByStudent.get(attendance.StudentId);
    console.log(`${student?.student_code || attendance.StudentId} - ${student?.name || 'Unknown'}: ${check?.status || 'missing'} -> complete`);
  }
}

async function applyChanges() {
  if (!confirm) throw new Error('Refusing to modify data without --confirm.');

  const transaction = await sequelize.transaction();
  try {
    const session = await findTarget(transaction);
    const scope = await loadScope(session, transaction);
    const attendedStudentIds = [...new Set(scope.attendances.map(attendance => attendance.StudentId))];

    if (attendedStudentIds.length) {
      await HomeworkCheck.update(
        { status: 'complete' },
        { where: { SessionId: session.id, StudentId: attendedStudentIds }, transaction },
      );

      const existingStudentIds = new Set(scope.existingChecks.map(check => check.StudentId));
      const missingStudentIds = attendedStudentIds.filter(studentId => !existingStudentIds.has(studentId));
      if (missingStudentIds.length) {
        await HomeworkCheck.bulkCreate(
          missingStudentIds.map(StudentId => ({ StudentId, SessionId: session.id, status: 'complete' })),
          { transaction },
        );
      }
    }

    const finalChecks = attendedStudentIds.length
      ? await HomeworkCheck.findAll({ where: { SessionId: session.id, StudentId: attendedStudentIds }, transaction })
      : [];
    if (finalChecks.length !== attendedStudentIds.length || finalChecks.some(check => check.status !== 'complete')) {
      throw new Error('Safety check failed: not every attended student has a complete homework check.');
    }

    await transaction.commit();
    console.log(`\nCompleted: ${finalChecks.length} attended student(s) marked as complete for serial ${targetSerial}.`);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function main() {
  if (!targetSerial) return;
  try {
    await sequelize.authenticate();
    const session = await findTarget();
    const scope = await loadScope(session);
    printPreview(session, scope);
    if (!apply) {
      console.log('\nRead-only preview complete. No changes were made.');
      return;
    }
    await applyChanges();
  } catch (error) {
    console.error(`\nFailed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

main();