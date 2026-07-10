const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ScheduleEntry = sequelize.define('ScheduleEntry', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  day_of_week: { type: DataTypes.INTEGER, allowNull: false }, // 0=أحد ... 6=سبت
  start_time: { type: DataTypes.STRING(8), allowNull: false }, // Store as VARCHAR(8) for HH:MM format
  duration_minutes: { type: DataTypes.INTEGER, defaultValue: 90 },
  SubjectId: { type: DataTypes.INTEGER, allowNull: false },
  CenterId: { type: DataTypes.INTEGER, allowNull: false },
  is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
  expected_sessions_count: { type: DataTypes.INTEGER, allowNull: true },
  end_date: { type: DataTypes.DATEONLY, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
}, {
  hooks: {
    beforeCreate(entry) {
      // Normalize time format to HH:MM
      if (entry.start_time && typeof entry.start_time === 'string') {
        entry.start_time = entry.start_time.slice(0, 5); // Keep only HH:MM
      }
    },
    beforeUpdate(entry) {
      if (entry.changed('start_time') && entry.start_time) {
        entry.start_time = entry.start_time.slice(0, 5);
      }
    }
  }
});

module.exports = ScheduleEntry;