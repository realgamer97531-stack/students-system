const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Ad = sequelize.define('Ad', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  ad_type: {
    type: DataTypes.ENUM('image', 'design'),
    allowNull: false,
    defaultValue: 'image',
  },
  image_url: {
    type: DataTypes.STRING(500),
    allowNull: true,
  },
  link_url: {
    type: DataTypes.STRING(500),
    allowNull: true,
  },
  design: {
    type: DataTypes.TEXT,
    allowNull: true, // JSON.stringify للتصميم لما ad_type يكون design
  },
  target_mode: {
    type: DataTypes.ENUM('all', 'filtered'),
    allowNull: false,
    defaultValue: 'filtered',
  },
  target_center_ids: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '[]',
  },
  target_subject_ids: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '[]',
  },
  balance_filter_enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  balance_max: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  booklet_filter_enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  booklet_paid_max: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  target_student_ids: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '[]',
  },
  target_pages: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '[]', // JSON array من مفاتيح الصفحات (فاضي = كل الصفحات)
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  priority: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  tableName: 'Ads',
});

module.exports = Ad;
