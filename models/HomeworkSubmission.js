const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const HomeworkSubmission = sequelize.define('HomeworkSubmission', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  images: { type: DataTypes.TEXT, allowNull: false, defaultValue: '[]' },
  student_comment: { type: DataTypes.TEXT, allowNull: true },
  status: {
    type: DataTypes.ENUM('submitted', 'complete', 'incomplete', 'no_steps', 'not_done'),
    defaultValue: 'submitted',
  },
  graded_by: { type: DataTypes.INTEGER, allowNull: true },
  graded_at: { type: DataTypes.DATE, allowNull: true },
});

module.exports = HomeworkSubmission;