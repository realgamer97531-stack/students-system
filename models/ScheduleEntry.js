const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ScheduleEntry = sequelize.define('ScheduleEntry', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  day_of_week: { type: DataTypes.INTEGER, allowNull: false }, // 0=أحد ... 6=سبت
  start_time: { type: DataTypes.TIME, allowNull: false },
  duration_minutes: { type: DataTypes.INTEGER, defaultValue: 90 },
  SubjectId: { type: DataTypes.INTEGER, allowNull: false },
  CenterId: { type: DataTypes.INTEGER, allowNull: false },
  is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
  expected_sessions_count: { type: DataTypes.INTEGER, allowNull: true },
  end_date: { type: DataTypes.DATEONLY, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
});

module.exports = ScheduleEntry;