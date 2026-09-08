const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const VideoAccessGrant = sequelize.define('VideoAccessGrant', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  method: {
    type: DataTypes.ENUM('attended', 'paid', 'admin_free', 'admin_paid'),
    allowNull: false,
  },
  max_views: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  views_used: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  access_started_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  access_expires_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  access_duration_hours: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
}, {
  tableName: 'videoaccessgrants',
});

module.exports = VideoAccessGrant;
