const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const RechargeCenterAccount = sequelize.define('RechargeCenterAccount', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  username: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  password_hash: { type: DataTypes.STRING(255), allowNull: false },
  recharge_center_id: { type: DataTypes.INTEGER, allowNull: false },
}, {
  tableName: 'RechargeCenterAccounts',
});

module.exports = RechargeCenterAccount;
