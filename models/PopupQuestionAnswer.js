const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// إجابة طالب واحد على سؤال منبثق واحد (محاولة واحدة بس لكل طالب).
const PopupQuestionAnswer = sequelize.define('PopupQuestionAnswer', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  PopupQuestionId: { type: DataTypes.INTEGER, allowNull: false },
  StudentId: { type: DataTypes.INTEGER, allowNull: false },
  selected_choice: { type: DataTypes.STRING(1), allowNull: true }, // a | b | c | d (مقالي = null)
  essay_image_url: { type: DataTypes.STRING(500), allowNull: true },
  // answered = اختياري اتصحح تلقائي، pending = مقالي مستني التصحيح، graded = مقالي اتصحح
  status: { type: DataTypes.ENUM('answered', 'pending', 'graded'), allowNull: false, defaultValue: 'answered' },
  is_correct: { type: DataTypes.BOOLEAN, allowNull: true }, // null = لسه متصححش
  points_awarded: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  graded_by: { type: DataTypes.INTEGER, allowNull: true },
  graded_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'popupquestionanswers',
  indexes: [
    { unique: true, fields: ['PopupQuestionId', 'StudentId'] },
    { fields: ['StudentId'] },
  ],
});

module.exports = PopupQuestionAnswer;
