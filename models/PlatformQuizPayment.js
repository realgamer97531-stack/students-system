const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// دفع الطالب لاختبار شامل بسعر: مرة واحدة بس، والإعادة بعد كده من غير دفع تاني.
const PlatformQuizPayment = sequelize.define('PlatformQuizPayment', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  QuizId: { type: DataTypes.INTEGER, allowNull: false },
  StudentId: { type: DataTypes.INTEGER, allowNull: false },
  amount: { type: DataTypes.FLOAT, allowNull: false },
}, {
  tableName: 'platform_quiz_payments',
  indexes: [{ unique: true, fields: ['QuizId', 'StudentId'] }],
});

module.exports = PlatformQuizPayment;
