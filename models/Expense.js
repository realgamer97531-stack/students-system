const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Expense = sequelize.define('Expense', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  amount: { type: DataTypes.FLOAT, allowNull: false },
  reason: { type: DataTypes.STRING, allowNull: false },
  type: { type: DataTypes.ENUM('daily', 'weekly', 'monthly', 'other'), defaultValue: 'other' },
  expense_date: { type: DataTypes.DATEONLY, allowNull: false },
});

module.exports = Expense;