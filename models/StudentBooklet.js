const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');


const StudentBooklet = sequelize.define('StudentBooklet', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  paid_amount: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  is_delivered: { type: DataTypes.BOOLEAN, defaultValue: false },
  delivered_at: { type: DataTypes.DATE, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  custom_price: { type: DataTypes.FLOAT, allowNull: true },
});

module.exports = StudentBooklet;