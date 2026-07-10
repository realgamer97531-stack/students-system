const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const AssistantAttendance = sequelize.define('AssistantAttendance', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  check_in: { type: DataTypes.DATE, allowNull: true },
  check_out: { type: DataTypes.DATE, allowNull: true },
  check_in_method: { type: DataTypes.ENUM('manual', 'auto'), defaultValue: 'manual' },
  check_out_method: { type: DataTypes.ENUM('manual', 'auto'), defaultValue: 'manual' },
  working_minutes: { type: DataTypes.INTEGER, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  salary_type: { type: DataTypes.ENUM('fixed', 'hourly', 'per_session'), defaultValue: 'fixed' },
  salary_amount: { type: DataTypes.FLOAT, allowNull: true },
  salary_calculated: { type: DataTypes.FLOAT, allowNull: true },
});

module.exports = AssistantAttendance;