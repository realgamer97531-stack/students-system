const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// سجل صلاحيات الطلاب على فيديوهات نظام البث الجديد
const VideoBroadcastAccess = sequelize.define('VideoBroadcastAccess', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  VideoBroadcastId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  StudentId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  method: {
    type: DataTypes.ENUM('paid', 'admin_free'),
    allowNull: false,
  },
  granted_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'video_broadcast_access',
});

module.exports = VideoBroadcastAccess;
