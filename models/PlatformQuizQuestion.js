const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// سؤال جوه اختبار المنصة. النص ممكن يكون فيه معادلات LaTeX بين \( \) أو \[ \].
// mcq = اختيار من متعدد (تصحيح تلقائي)، essay = مقالي، bonus = درجة من غير إجابة
const PlatformQuizQuestion = sequelize.define('PlatformQuizQuestion', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  QuizId: { type: DataTypes.INTEGER, allowNull: false },
  order_index: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  type: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'mcq' },
  text: { type: DataTypes.TEXT, allowNull: true },
  image_url: { type: DataTypes.STRING(1000), allowNull: true },
  choices: { type: DataTypes.TEXT, allowNull: true }, // JSON [{ text, image }]
  correct_index: { type: DataTypes.INTEGER, allowNull: true },
  marks: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 2 },
  // مقالي بس: لو true الطالب لازم يكتب إجابة والمساعد يصححها، لو false بياخد الدرجة تلقائي
  requires_answer: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
  tableName: 'platform_quiz_questions',
  indexes: [{ fields: ['QuizId', 'order_index'] }],
});

module.exports = PlatformQuizQuestion;
