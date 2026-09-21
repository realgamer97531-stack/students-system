const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// نظام بث الفيديوهات الجديد - قسم منفصل تمامًا عن نظام الفيديوهات القديم (Video/VideoPart/VideoAccessGrant)
const VideoBroadcast = sequelize.define('VideoBroadcast', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  video_url: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  target_pages: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '[]', // JSON array من مفاتيح الصفحات (فاضي = كل الصفحات)
  },
  access_type: {
    type: DataTypes.ENUM('free', 'paid'),
    allowNull: false,
    defaultValue: 'free',
  },
  SessionId: {
    type: DataTypes.INTEGER,
    allowNull: true, // الحصة المرتبطة بالفيديو (يُستخدم عند access_type = paid)
  },
  price: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  priority: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  tableName: 'video_broadcasts',
});

module.exports = VideoBroadcast;
