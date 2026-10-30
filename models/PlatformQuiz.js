const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// اختبار على المنصة (بديل رابط جوجل فورم): بيظهر جوه أسبوع معين وبيقفل حصص الأسبوع ده لحد ما الطالب يحله.
// مفيش Foreign Keys عمدًا عشان الجدول يتعمل بشكل مستقل وآمن.
const PlatformQuiz = sequelize.define('PlatformQuiz', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  SubjectId: { type: DataTypes.INTEGER, allowNull: false },
  week_number: { type: DataTypes.INTEGER, allowNull: false }, // الأسبوع اللي الاختبار بيظهر فيه وبيقفله (الشامل: بيظهر بعده)
  // شامل: بيظهر لوحده بين أسبوعين مش جوه حصة، مبيقفلش أي حصة، وله سعره
  is_shamel: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  price: { type: DataTypes.FLOAT, allowNull: true }, // الشامل بس. فاضي أو صفر = مجاني
  center_ids: { type: DataTypes.TEXT, allowNull: true }, // JSON [ids] — null = كل سناتر المادة
  title: { type: DataTypes.STRING(200), allowNull: false },
  instructions: { type: DataTypes.TEXT, allowNull: true },
  time_limit_minutes: { type: DataTypes.INTEGER, allowNull: true }, // null = من غير وقت
  answer_video_url: { type: DataTypes.STRING(1000), allowNull: true },
  is_published: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  // "إعادة للكل": أي محاولة اتسلمت قبل الوقت ده الطالب يقدر يعيدها
  redo_all_at: { type: DataTypes.DATE, allowNull: true },
  created_by: { type: DataTypes.INTEGER, allowNull: true },
}, {
  tableName: 'platform_quizzes',
  indexes: [{ fields: ['SubjectId', 'week_number'] }],
});

module.exports = PlatformQuiz;
