const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  username: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false, // هنخزن فيه الباسورد بعد التشفير، مش النص الصريح
  },
  role: {
    type: DataTypes.ENUM('admin', 'assistant'),
    allowNull: false,
    defaultValue: 'assistant',
  },
  permissions: {
    type: DataTypes.TEXT,
    allowNull: true, // هنخزن فيه JSON array من أسماء الصلاحيات
  },
}, {
  tableName: 'users',
});

module.exports = User;
