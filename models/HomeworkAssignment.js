const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const HomeworkAssignment = sequelize.define('HomeworkAssignment', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  title: { type: DataTypes.STRING, allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: true },
  order_number: { type: DataTypes.INTEGER, allowNull: false },
  start_date: { type: DataTypes.DATEONLY, allowNull: false },
  end_date: { type: DataTypes.DATEONLY, allowNull: false },
  SubjectId: { type: DataTypes.INTEGER, allowNull: true },
  SessionId: { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = HomeworkAssignment;