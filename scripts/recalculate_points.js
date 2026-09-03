require('dotenv').config();
const sequelize = require('../config/database');
const Student = require('../models/Student');
const Attendance = require('../models/Attendance');
const ExamResult = require('../models/ExamResult');
const HomeworkCheck = require('../models/HomeworkCheck');
const WatchProgress = require('../models/WatchProgress');
const BalanceTransaction = require('../models/BalanceTransaction');
require('../models/associations')();

const automaticPointReason = /^نقاط: (حضور حصة|درجة امتحان:|واجب كامل|واجب غير كامل|واجب بدون خطوات|الواجب غير المحلول|مشاهدة فيديو)/;
const homeworkPoints = { complete: 3, incomplete: 1, no_steps: 0, not_done: -2 };

async function main() {
  const [students, attendances, examResults, homeworkChecks, watchProgresses, pointTransactions] = await Promise.all([
    Student.findAll({ attributes: ['id'] }),
    Attendance.findAll({ attributes: ['StudentId', 'SessionId'] }),
    ExamResult.findAll({ attributes: ['StudentId', 'score'] }),
    HomeworkCheck.findAll({ attributes: ['StudentId', 'SessionId', 'status', 'createdAt'], order: [['createdAt', 'ASC']] }),
    WatchProgress.findAll({ attributes: ['StudentId', 'VideoPartId'] }),
    BalanceTransaction.findAll({ attributes: ['StudentId', 'amount', 'reason'] }),
  ]);

  const totals = new Map(students.map(student => [student.id, 0]));
  const add = (studentId, amount) => totals.set(studentId, (totals.get(studentId) || 0) + (Number(amount) || 0));

  const attendanceKeys = new Set();
  attendances.forEach(attendance => {
    const key = `${attendance.StudentId}:${attendance.SessionId}`;
    if (!attendanceKeys.has(key)) {
      attendanceKeys.add(key);
      add(attendance.StudentId, 2);
    }
  });

  examResults.forEach(result => add(result.StudentId, Math.round(Number(result.score) || 0)));

  const latestHomework = new Map();
  homeworkChecks.forEach(check => latestHomework.set(`${check.StudentId}:${check.SessionId}`, check));
  latestHomework.forEach(check => add(check.StudentId, homeworkPoints[check.status] || 0));

  const videoKeys = new Set();
  watchProgresses.forEach(progress => {
    const key = `${progress.StudentId}:${progress.VideoPartId}`;
    if (!videoKeys.has(key)) {
      videoKeys.add(key);
      add(progress.StudentId, 1);
    }
  });

  pointTransactions.forEach(transaction => {
    if (transaction.reason && transaction.reason.startsWith('نقاط:') && !automaticPointReason.test(transaction.reason)) {
      add(transaction.StudentId, transaction.amount);
    }
  });

  for (const student of students) {
    await Student.update({ points: totals.get(student.id) || 0 }, { where: { id: student.id } });
  }

  console.log(`Recalculated points for ${students.length} students.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => sequelize.close());