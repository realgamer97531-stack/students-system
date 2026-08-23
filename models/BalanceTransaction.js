const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BalanceTransaction = sequelize.define('BalanceTransaction', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  amount: {
    type: DataTypes.FLOAT,
    allowNull: false, // ممكن تكون رقم سالب (خصم) أو موجب (إضافة)
  },
  SessionId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  reason: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  tableName: 'balancetransactions',
});

module.exports = BalanceTransaction;
