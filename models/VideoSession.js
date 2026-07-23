const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const VideoSession = sequelize.define('VideoSession', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  VideoId: { type: DataTypes.INTEGER, allowNull: false },
  SessionId: { type: DataTypes.INTEGER, allowNull: false },
});

module.exports = VideoSession;