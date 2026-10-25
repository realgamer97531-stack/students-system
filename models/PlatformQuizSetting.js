const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// زرار التشغيل لكل مادة: enabled = الاختبار على المنصة بيحل محل روابط جوجل فورم القديمة.
// قفله بيرجّع النظام القديم زي ما هو، ومفيش أي بيانات بتتمسح.
const PlatformQuizSetting = sequelize.define('PlatformQuizSetting', {
  SubjectId: { type: DataTypes.INTEGER, primaryKey: true },
  enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
  tableName: 'platform_quiz_settings',
});

module.exports = PlatformQuizSetting;
