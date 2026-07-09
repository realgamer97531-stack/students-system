const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Salary = sequelize.define('Salary', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  UserId: { type: DataTypes.INTEGER, allowNull: false },
  amount: { type: DataTypes.FLOAT, allowNull: false },
  month: { type: DataTypes.STRING, allowNull: false }, // مثال: "2026-07"
  notes: { type: DataTypes.TEXT, allowNull: true },
});

module.exports = Salary;