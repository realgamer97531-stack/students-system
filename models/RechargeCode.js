const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const RechargeCode = sequelize.define('RechargeCode', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  code: { type: DataTypes.STRING(20), allowNull: false, unique: true },
  amount: { type: DataTypes.FLOAT, allowNull: false },
  is_used: { type: DataTypes.BOOLEAN, defaultValue: false },
  recharge_center_id: { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = RechargeCode;