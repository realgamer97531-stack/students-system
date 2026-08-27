#!/usr/bin/env node
/**
 * One-off cleanup for a session selected by serial_number.
 *
 * Preview:
 *   node scripts/delete_session_6001.js 6001
 * Apply after reviewing the preview:
 *   node scripts/delete_session_6001.js 6001 --apply --confirm
 */

require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
require('../models/associations')();

const Session = require('../models/Session');
const Attendance = require('../models/Attendance');
const HomeworkCheck = require('../models/HomeworkCheck');
const BalanceTransaction = require('../models/BalanceTransaction');
const Exam = require('../models/Exam');
const ExamResult = require('../models/ExamResult');
const SessionComment = require('../models/SessionComment');
const AssistantAttendance = require('../models/AssistantAttendance');
const Video = require('../models/Video');
const VideoPart = require('../models/VideoPart');
const VideoSession = require('../models/VideoSession');
const VideoStudentAccess = require('../models/VideoStudentAccess');
const WatchProgress = require('../models/WatchProgress');
const VideoAccessGrant = require('../models/VideoAccessGrant');
const HomeworkAssignment = require('../models/HomeworkAssignment');
const HomeworkAssignmentSession = require('../models/HomeworkAssignmentSession');
const HomeworkSubmission = require('../models/HomeworkSubmission');
const Student = require('../models/Student');

const serialArgument = process.argv.slice(2).find(argument => /^\d+$/.test(argument));
const TARGET_SERIAL = serialArgument ? Number(serialArgument) : 6001;
const APPLY = process.argv.includes('--apply');
const CONFIRM = process.argv.includes('--confirm');

function asPlain(record) {
  return record && typeof record.toJSON === 'function' ? record.toJSON() : record;
}

function printSection(title, rows) {
  console.log(`\n${title}: ${rows.length}`);
  rows.forEach(row => console.log(JSON.stringify(asPlain(row))));
}

async function findTarget(transaction) {
  const rows = await Session.findAll({
    where: { serial_number: TARGET_SERIAL },
    order: [['id', 'ASC']],
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (rows.length !== 1) {
    throw new Error(`Safety check failed: expected exactly one session with serial_number ${TARGET_SERIAL}, found ${rows.length}.`);
  }
  return rows[0];
}

async function collectData(session, transaction) {
  const sessionId = session.id;
  const videos = await Video.findAll({ where: { SessionId: sessionId }, transaction });
  const videoIds = videos.map(video => video.id);
  const videoLinks = await VideoSession.findAll({ where: { SessionId: sessionId }, transaction });
  videoLinks.forEach(link => { if (!videoIds.includes(link.VideoId)) videoIds.push(link.VideoId); });
  const videoParts = videoIds.length ? await VideoPart.findAll({ where: { VideoId: videoIds }, transaction }) : [];
  const videoPartIds = videoParts.map(part => part.id);

  const assignmentLinks = await HomeworkAssignmentSession.findAll({ where: { SessionId: sessionId }, transaction });
  const directAssignments = await HomeworkAssignment.findAll({ where: { SessionId: sessionId }, transaction });
  const linkedAssignmentIds = assignmentLinks.map(link => link.HomeworkAssignmentId);
  const linkedAssignments = linkedAssignmentIds.length
    ? await HomeworkAssignment.findAll({ where: { id: linkedAssignmentIds }, transaction })
    : [];
  const assignments = [...directAssignments, ...linkedAssignments.filter(assignment => !directAssignments.some(direct => direct.id === assignment.id))];
  const assignmentIds = assignments.map(assignment => assignment.id);
  const submissions = assignmentIds.length
    ? await HomeworkSubmission.findAll({ where: { HomeworkAssignmentId: assignmentIds }, transaction })
    : [];

  return {
    sessionId,
    attendances: await Attendance.findAll({ where: { SessionId: sessionId }, transaction }),
    homeworkChecks: await HomeworkCheck.findAll({ where: { SessionId: sessionId }, transaction }),
    balanceTransactions: await BalanceTransaction.findAll({ where: { SessionId: sessionId }, transaction }),
    exams: await Exam.findAll({ where: { SessionId: sessionId }, transaction }),
    comments: await SessionComment.findAll({ where: { SessionId: sessionId }, transaction }),
    assistantAttendances: await AssistantAttendance.findAll({ where: { SessionId: sessionId }, transaction }),
    videos,
    videoLinks,
    videoParts,
    videoStudentAccess: videoIds.length ? await VideoStudentAccess.findAll({ where: { VideoId: videoIds }, transaction }) : [],
    watchProgress: videoPartIds.length ? await WatchProgress.findAll({ where: { VideoPartId: videoPartIds }, transaction }) : [],
    accessGrants: await VideoAccessGrant.findAll({ where: { SessionId: sessionId }, transaction }),
    examResults: await ExamResult.findAll({ where: { ExamId: (await Exam.findAll({ where: { SessionId: sessionId }, attributes: ['id'], transaction })).map(exam => exam.id) }, transaction }),
    assignments,
    assignmentLinks,
    submissions,
  };
}

function printSummary(session, data) {
  console.log(`Target session: id=${session.id}, serial_number=${session.serial_number}, lesson_number=${session.lesson_number}`);
  printSection('Attendances', data.attendances);
  printSection('Session-linked balance transactions', data.balanceTransactions);
  printSection('Homework checks', data.homeworkChecks);
  printSection('Exams', data.exams);
  printSection('Exam results', data.examResults);
  printSection('Session comments', data.comments);
  printSection('Assistant attendances', data.assistantAttendances);
  printSection('Videos', data.videos);
  printSection('Video links', data.videoLinks);
  printSection('Video parts', data.videoParts);
  printSection('Video access grants', data.accessGrants);
  printSection('Watch progress', data.watchProgress);
  printSection('Video student access', data.videoStudentAccess);
  printSection('Homework assignments', data.assignments);
  printSection('Homework assignment links', data.assignmentLinks);
  printSection('Homework submissions', data.submissions);

  const ambiguousMoney = data.attendances.filter(attendance => Number(attendance.payment_collected || 0) !== 0);
  if (ambiguousMoney.length) {
    console.log(`\nWARNING: ${ambiguousMoney.length} attendance payment(s) have no SessionId on their transaction rows.`);
    console.log('The apply step restores the attendance net effect using the current student session price and payment_collected, but does not delete unlinked transaction rows.');
  }
  const paidGrants = data.accessGrants.filter(grant => grant.method === 'paid');
  if (paidGrants.length) {
    console.log(`\nWARNING: ${paidGrants.length} paid video-access debit(s) are matched by serial number, because their transactions have no SessionId.`);
  }
}

async function removeLocalVideoFiles(videoParts) {
  for (const part of videoParts) {
    if (!part.file_path || !part.file_path.startsWith('/uploads/videos/')) continue;
    const filePath = path.join(__dirname, '..', 'public', part.file_path.replace(/^\/+/, ''));
    try {
      await fs.unlink(filePath);
      console.log(`Deleted recording file: ${filePath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`Could not delete recording file ${filePath}: ${error.message}`);
    }
  }
}

async function applyCleanup() {
  if (!CONFIRM) throw new Error('Refusing to modify data without --confirm.');
  const transaction = await sequelize.transaction();
  let data;
  let session;
  try {
    session = await findTarget(transaction);
    data = await collectData(session, transaction);

    const videoIds = [...new Set([...data.videos.map(video => video.id), ...data.videoLinks.map(link => link.VideoId)])];
    const sharedVideoIds = videoIds.length
      ? (await VideoSession.findAll({ where: { VideoId: videoIds, SessionId: { [Op.ne]: session.id } }, attributes: ['VideoId'], transaction })).map(row => row.VideoId)
      : [];
    const deletableVideoIds = videoIds.filter(id => !sharedVideoIds.includes(id));
    const deletablePartIds = data.videoParts.filter(part => deletableVideoIds.includes(part.VideoId)).map(part => part.id);

    await WatchProgress.destroy({ where: { VideoPartId: deletablePartIds }, transaction });
    await VideoStudentAccess.destroy({ where: { VideoId: deletableVideoIds }, transaction });
    await VideoAccessGrant.destroy({ where: { SessionId: session.id }, transaction });
    await VideoSession.destroy({ where: { SessionId: session.id }, transaction });
    await VideoPart.destroy({ where: { id: deletablePartIds }, transaction });
    await Video.destroy({ where: { id: deletableVideoIds }, transaction });
    await Attendance.destroy({ where: { SessionId: session.id }, transaction });
    await HomeworkCheck.destroy({ where: { SessionId: session.id }, transaction });
    await BalanceTransaction.destroy({ where: { SessionId: session.id }, transaction });
    await ExamResult.destroy({ where: { ExamId: data.exams.map(exam => exam.id) }, transaction });
    await Exam.destroy({ where: { id: data.exams.map(exam => exam.id) }, transaction });
    await SessionComment.destroy({ where: { SessionId: session.id }, transaction });
    await AssistantAttendance.destroy({ where: { SessionId: session.id }, transaction });
    await HomeworkAssignmentSession.destroy({ where: { SessionId: session.id }, transaction });

    for (const assignment of data.assignments) {
      const remainingLinks = await HomeworkAssignmentSession.count({ where: { HomeworkAssignmentId: assignment.id }, transaction });
      if (!remainingLinks && assignment.SessionId === session.id) {
        await HomeworkSubmission.destroy({ where: { HomeworkAssignmentId: assignment.id }, transaction });
        await HomeworkAssignment.destroy({ where: { id: assignment.id }, transaction });
      }
    }

    const students = await Student.findAll({ where: { id: data.attendances.map(attendance => attendance.StudentId) }, transaction });
    for (const attendance of data.attendances) {
      const student = students.find(row => row.id === attendance.StudentId);
      if (!student) continue;
      if (String(attendance.comment || '').startsWith('📹')) continue;
      const paymentCollected = Number(attendance.payment_collected || 0);
      const sessionPrice = Number(student.price_per_session || 0);
      if (paymentCollected || sessionPrice) {
        student.balance = Number(student.balance || 0) + sessionPrice - paymentCollected;
        await student.save({ transaction });
      }
    }

    const paidGrantStudents = await Student.findAll({
      where: { id: data.accessGrants.filter(grant => grant.method === 'paid').map(grant => grant.StudentId) },
      transaction,
    });
    const paidReason = `دفع لمشاهدة حصة أونلاين (سيريال ${TARGET_SERIAL})`;
    for (const grant of data.accessGrants.filter(row => row.method === 'paid')) {
      const student = paidGrantStudents.find(row => row.id === grant.StudentId);
      if (!student) throw new Error(`Safety check failed: student ${grant.StudentId} for paid grant ${grant.id} was not found.`);
      const amount = Number(student.price_per_session || 0);
      const matchingTransactions = await BalanceTransaction.findAll({
        where: { StudentId: student.id, amount: -amount, reason: paidReason },
        transaction,
      });
      if (matchingTransactions.length !== 1) {
        throw new Error(`Safety check failed: expected exactly one matching debit for paid grant ${grant.id}, found ${matchingTransactions.length}.`);
      }
      student.balance = Number(student.balance || 0) + amount;
      await student.save({ transaction });
      await matchingTransactions[0].destroy({ transaction });
    }

    await Session.destroy({ where: { id: session.id }, transaction });
    await transaction.commit();
    await removeLocalVideoFiles(data.videoParts.filter(part => deletableVideoIds.includes(part.VideoId)));
    console.log(`\nCleanup completed for session serial_number ${TARGET_SERIAL}.`);
    console.log(`Shared videos preserved: ${sharedVideoIds.length}.`);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function main() {
  try {
    await sequelize.authenticate();
    const session = await findTarget();
    const data = await collectData(session);
    printSummary(session, data);
    if (!APPLY) {
      console.log('\nRead-only preview complete. No changes were made.');
      return;
    }
    await applyCleanup();
  } catch (error) {
    console.error(`\nFailed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

main();