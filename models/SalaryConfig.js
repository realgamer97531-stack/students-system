const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SalaryConfig = sequelize.define('SalaryConfig', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  UserId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  salary_type: { type: DataTypes.ENUM('fixed', 'hourly', 'per_session'), defaultValue: 'fixed' },
  base_amount: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  notes: { type: DataTypes.TEXT, allowNull: true },
});

module.exports = SalaryConfig;