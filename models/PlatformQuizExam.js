const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// الامتحان (جدول exams) اللي درجات اختبار المنصة بتتسجل فيه عشان تظهر في جدول الطالب والمتابعة والتقارير.
// امتحان لكل سنتر (الامتحان بيترتبط بحصة، والحصة لسنتر واحد)، والشامل امتحان واحد CenterId = 0.
const PlatformQuizExam = sequelize.define('PlatformQuizExam', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  QuizId: { type: DataTypes.INTEGER, allowNull: false },
  CenterId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  ExamId: { type: DataTypes.INTEGER, allowNull: false },
}, {
  tableName: 'platform_quiz_exams',
  indexes: [{ unique: true, fields: ['QuizId', 'CenterId'] }],
});

module.exports = PlatformQuizExam;
