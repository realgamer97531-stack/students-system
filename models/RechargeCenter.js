const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const RechargeCenter = sequelize.define('RechargeCenter', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING(150), allowNull: false, unique: true },
}, {
  tableName: 'RechargeCenters',
});

module.exports = RechargeCenter;
