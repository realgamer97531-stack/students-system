const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// سؤال منبثق (Popup) بيظهر للطالب جوه صفحة الدرس أثناء/بعد الفيديو.
// مفيش Foreign Keys عمدًا (أعمدة عادية) عشان الجدول ده يتعمل بشكل مستقل وآمن.
const PopupQuestion = sequelize.define('PopupQuestion', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  VideoId: { type: DataTypes.INTEGER, allowNull: false },
  VideoPartId: { type: DataTypes.INTEGER, allowNull: false }, // الجزء اللي السؤال بيظهر فيه
  title: { type: DataTypes.STRING, allowNull: true }, // اسم داخلي للأدمن
  question_type: { type: DataTypes.ENUM('mcq', 'essay'), allowNull: false, defaultValue: 'mcq' },
  trigger_type: { type: DataTypes.ENUM('end', 'time'), allowNull: false, defaultValue: 'end' },
  trigger_seconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  question_text: { type: DataTypes.TEXT, allowNull: false },
  question_image_url: { type: DataTypes.STRING(500), allowNull: true },
  choice_a: { type: DataTypes.TEXT, allowNull: true },
  choice_b: { type: DataTypes.TEXT, allowNull: true },
  choice_c: { type: DataTypes.TEXT, allowNull: true },
  choice_d: { type: DataTypes.TEXT, allowNull: true },
  choice_a_image: { type: DataTypes.STRING(500), allowNull: true },
  choice_b_image: { type: DataTypes.STRING(500), allowNull: true },
  choice_c_image: { type: DataTypes.STRING(500), allowNull: true },
  choice_d_image: { type: DataTypes.STRING(500), allowNull: true },
  correct_choice: { type: DataTypes.STRING(1), allowNull: true }, // a | b | c | d (مقالي = null)
  solution_video_url: { type: DataTypes.STRING(1000), allowNull: true },
  solution_start_seconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  solution_end_seconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // 0 = لحد آخر الفيديو
  solution_min_seconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // أقل وقت قبل ما الطالب يقدر يقفل
  bonus_points: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
  design: { type: DataTypes.TEXT, allowNull: true }, // JSON بخيارات التصميم
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
  tableName: 'popupquestions',
  indexes: [{ fields: ['VideoId'] }, { fields: ['VideoPartId'] }],
});

module.exports = PopupQuestion;
