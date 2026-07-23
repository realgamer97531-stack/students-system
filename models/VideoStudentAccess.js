const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const VideoStudentAccess = sequelize.define('VideoStudentAccess', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  VideoId: { type: DataTypes.INTEGER, allowNull: false },
  StudentId: { type: DataTypes.INTEGER, allowNull: false },
});

module.exports = VideoStudentAccess;