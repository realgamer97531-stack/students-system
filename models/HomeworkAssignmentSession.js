const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const HomeworkAssignmentSession = sequelize.define('HomeworkAssignmentSession', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  HomeworkAssignmentId: { type: DataTypes.INTEGER, allowNull: false },
  SessionId: { type: DataTypes.INTEGER, allowNull: false },
});

module.exports = HomeworkAssignmentSession;
