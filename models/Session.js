const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');


const Session = sequelize.define('Session', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  lesson_number: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  week_number: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  serial_number: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  session_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  status: {
    type: DataTypes.ENUM('normal', 'cancelled'),
    allowNull: false,
    defaultValue: 'normal',
  },
  is_free_for_all: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false, // لو true، مفتوحة لأي طالب من غير دفع أو حضور
  },
  views_if_attended: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 2,
  },
  views_if_paid: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 3,
  },
  homework_video_url: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  exam_url: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  exam_video_url: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
  cost_per_normal: { type: DataTypes.FLOAT, allowNull: true },
  cost_per_reduced: { type: DataTypes.FLOAT, allowNull: true },
}, {
  tableName: 'sessions',
});


module.exports = Session;
