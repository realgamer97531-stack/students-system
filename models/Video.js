const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Video = sequelize.define('Video', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false, // مثال: "التفاضل - الجزء الأول"
  },
  questions_display: {
    type: DataTypes.ENUM('inside', 'outside', 'both'),
    allowNull: false,
    defaultValue: 'inside', // فين تظهر فيديوهات الأسئلة: جوه الدرس / برا جنب الحصة / الاتنين
  },
  is_visible: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true, // false = الدرس مستخبي عن الطلاب (البوابة والأبلكيشن)، والموظفين لسه شايفينه
  },
}, {
  tableName: 'videos',
});

module.exports = Video;
