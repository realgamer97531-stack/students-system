const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Booklet = sequelize.define('Booklet', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING, allowNull: false },
  SubjectId: { type: DataTypes.INTEGER, allowNull: false },
  print_price: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  sell_price: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  stock_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
  order_index: { type: DataTypes.INTEGER, defaultValue: 1 },
});

module.exports = Booklet;