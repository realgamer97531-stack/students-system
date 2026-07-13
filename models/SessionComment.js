const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SessionComment = sequelize.define('SessionComment', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  StudentId: { type: DataTypes.INTEGER, allowNull: false },
  SessionId: { type: DataTypes.INTEGER, allowNull: false },
  UserId: { type: DataTypes.INTEGER, allowNull: false },
  comment: { type: DataTypes.TEXT, allowNull: false },
});

module.exports = SessionComment;