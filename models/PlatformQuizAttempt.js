const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// محاولة طالب في اختبار المنصة. محاولة واحدة بس، إلا لو الأدمن سمح بإعادة (redo_allowed أو redo_all_at في الاختبار).
const PlatformQuizAttempt = sequelize.define('PlatformQuizAttempt', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  QuizId: { type: DataTypes.INTEGER, allowNull: false },
  StudentId: { type: DataTypes.INTEGER, allowNull: false },
  attempt_no: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'in_progress' }, // in_progress | submitted
  started_at: { type: DataTypes.DATE, allowNull: false },
  deadline_at: { type: DataTypes.DATE, allowNull: true },
  submitted_at: { type: DataTypes.DATE, allowNull: true },
  answers: { type: DataTypes.TEXT('medium'), allowNull: true }, // JSON { questionId: { choice } | { text, image } }
  results: { type: DataTypes.TEXT('medium'), allowNull: true }, // JSON { questionId: { earned, max, correct, pending } }
  score: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
  max_score: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
  pending_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // أسئلة مقالي مستنية تصحيح
  auto_submitted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // الوقت خلص
  redo_allowed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
  tableName: 'platform_quiz_attempts',
  indexes: [
    { unique: true, fields: ['QuizId', 'StudentId', 'attempt_no'] },
    { fields: ['StudentId'] },
  ],
});

module.exports = PlatformQuizAttempt;
