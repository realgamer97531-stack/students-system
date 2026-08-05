require('dotenv').config();
const { Op } = require('sequelize');
const sequelize = require('./config/database');
require('./models/associations')();

const Center = require('./models/Center');
const Subject = require('./models/Subject');
const Student = require('./models/Student');
const CenterSubjectSeries = require('./models/CenterSubjectSeries');
const Session = require('./models/Session');
const Attendance = require('./models/Attendance');
const HomeworkCheck = require('./models/HomeworkCheck');
const BalanceTransaction = require('./models/BalanceTransaction');
const Exam = require('./models/Exam');
const ExamResult = require('./models/ExamResult');
const User = require('./models/User');
const Video = require('./models/Video');
const VideoPart = require('./models/VideoPart');
const WatchProgress = require('./models/WatchProgress');
const VideoAccessGrant = require('./models/VideoAccessGrant');
const Warning = require('./models/Warning');
const Booklet = require('./models/Booklet');
const StudentBooklet = require('./models/StudentBooklet');
const BookletReservation = require('./models/BookletReservation');
const FollowUpAssignment = require('./models/FollowUpAssignment');
const SessionComment = require('./models/SessionComment');
const VideoSession = require('./models/VideoSession');
const VideoStudentAccess = require('./models/VideoStudentAccess');
const HomeworkAssignment = require('./models/HomeworkAssignment');
const HomeworkAssignmentSession = require('./models/HomeworkAssignmentSession');
const HomeworkSubmission = require('./models/HomeworkSubmission');
const PaymentVerification = require('./models/PaymentVerification');
const RechargeCode = require('./models/RechargeCode');
const Salary = require('./models/Salary');
const SalaryConfig = require('./models/SalaryConfig');
const ScheduleEntry = require('./models/ScheduleEntry');
const Expense = require('./models/Expense');
const AssistantAttendance = require('./models/AssistantAttendance');

const PRESERVED_USER_ROLES = ['admin', 'assistant'];

async function clearDatabase() {
  console.log('🚨 Running database cleanup: preserving admin/assistant users, centers, and subjects only');

  if (!process.argv.includes('--confirm')) {
    console.log('Usage: node clearDatabase.js --confirm');
    console.log('This script will delete all data except admin/assistant users, center rows, and subject rows.');
    process.exit(1);
  }

  await sequelize.authenticate();
  const transaction = await sequelize.transaction();

  const deleteOrder = [
    WatchProgress,
    VideoAccessGrant,
    VideoStudentAccess,
    VideoSession,
    VideoPart,
    Video,
    Warning,
    Attendance,
    HomeworkCheck,
    BalanceTransaction,
    ExamResult,
    PaymentVerification,
    SessionComment,
    FollowUpAssignment,
    StudentBooklet,
    BookletReservation,
    HomeworkSubmission,
    HomeworkAssignmentSession,
    HomeworkAssignment,
    Exam,
    Session,
    Student,
    CenterSubjectSeries,
    Booklet,
    Salary,
    SalaryConfig,
    ScheduleEntry,
    Expense,
    AssistantAttendance,
    RechargeCode,
  ];

  try {
    for (const model of deleteOrder) {
      await model.destroy({ where: {}, transaction });
    }

    await User.destroy({
      where: {
        role: {
          [Op.notIn]: PRESERVED_USER_ROLES,
        },
      },
      transaction,
    });

    await transaction.commit();

    console.log('✅ Cleanup completed. Preserved users with roles admin/assistant, all centers, and all subjects.');
  } catch (error) {
    await transaction.rollback();
    console.error('❌ Cleanup failed:', error.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

clearDatabase();
