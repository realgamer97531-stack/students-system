const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const FollowUpAssignment = sequelize.define('FollowUpAssignment', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  AssistantId: { type: DataTypes.INTEGER, allowNull: false },
  StudentId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  assignedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
});

module.exports = FollowUpAssignment;