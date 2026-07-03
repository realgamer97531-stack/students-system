const Center = require('./Center');
const Subject = require('./Subject');
const Student = require('./Student');
const CenterSubjectSeries = require('./CenterSubjectSeries');
const Session = require('./Session');
const Attendance = require('./Attendance');
const HomeworkCheck = require('./HomeworkCheck');
const BalanceTransaction = require('./BalanceTransaction');
const Exam = require('./Exam');
const ExamResult = require('./ExamResult');
const User = require('./User');
const Video = require('./Video');
const VideoPart = require('./VideoPart');
const WatchProgress = require('./WatchProgress');
const VideoAccessGrant = require('./VideoAccessGrant');
const Warning = require('./Warning');
Student.hasMany(PaymentVerification, { foreignKey: 'StudentId' });
PaymentVerification.belongsTo(Student, { foreignKey: 'StudentId' });
const PaymentVerification = require('./PaymentVerification');

function setupAssociations() {
  Center.hasMany(Student);
  Student.belongsTo(Center);

  Subject.hasMany(Student);
  Student.belongsTo(Subject);

  Center.hasMany(CenterSubjectSeries);
  CenterSubjectSeries.belongsTo(Center);
  Subject.hasMany(CenterSubjectSeries);
  CenterSubjectSeries.belongsTo(Subject);

  Center.hasMany(Session);
  Session.belongsTo(Center);
  Subject.hasMany(Session);
  Session.belongsTo(Subject);

  Student.hasMany(Attendance);
  Attendance.belongsTo(Student);

  Session.hasMany(Attendance);
  Attendance.belongsTo(Session);

  Student.hasMany(HomeworkCheck);
  HomeworkCheck.belongsTo(Student);
  Session.hasMany(HomeworkCheck);
  HomeworkCheck.belongsTo(Session);

Student.hasMany(BalanceTransaction);
  BalanceTransaction.belongsTo(Student);

Subject.hasMany(Exam);
  Exam.belongsTo(Subject);

  Exam.hasMany(ExamResult);
  ExamResult.belongsTo(Exam);
  Student.hasMany(ExamResult);
  ExamResult.belongsTo(Student);
  Session.hasMany(Exam);
  Exam.belongsTo(Session);

  User.hasMany(Attendance);
  Attendance.belongsTo(User);

  User.hasMany(HomeworkCheck);
  HomeworkCheck.belongsTo(User);

  User.hasMany(BalanceTransaction);
  BalanceTransaction.belongsTo(User);

  User.hasMany(Student); // مين سجل الطالب أصلاً
  Student.belongsTo(User);

  User.hasMany(ExamResult);
  ExamResult.belongsTo(User);

  // فيديوهات مرتبطة بمادة معينة (ممكن لاحقًا نربطها بحصة معينة كمان)
  Subject.hasMany(Video);
  Video.belongsTo(Subject);

  Session.hasMany(Video); // اختياري: ربط فيديو بحصة بعينها
  Video.belongsTo(Session);

  Video.hasMany(VideoPart);
  VideoPart.belongsTo(Video);

  Student.hasMany(WatchProgress);
  WatchProgress.belongsTo(Student);
  VideoPart.hasMany(WatchProgress);
  WatchProgress.belongsTo(VideoPart);

  Student.hasMany(VideoAccessGrant);
  VideoAccessGrant.belongsTo(Student);
  Session.hasMany(VideoAccessGrant);
  VideoAccessGrant.belongsTo(Session);

  Student.hasMany(Warning);
  Warning.belongsTo(Student);
  User.hasMany(Warning);
  Warning.belongsTo(User);
}

module.exports = setupAssociations;
