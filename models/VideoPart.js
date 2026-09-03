const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const VideoPart = sequelize.define('VideoPart', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  category: {
    type: DataTypes.ENUM('explanation', 'questions', 'homework_solution'),
    allowNull: false, // شرح / أسئلة / حل واجب
  },
  order_index: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1, // ترتيب الجزء جوه نفس النوع (لو فيه أكتر من لينك)
  },
  source_type: {
    type: DataTypes.ENUM('link', 'upload'),
    allowNull: false,
    defaultValue: 'link',
  },
  video_url: {
    type: DataTypes.STRING,
    allowNull: true, // لو لينك
  },
  file_path: {
    type: DataTypes.STRING,
    allowNull: true, // لو ملف مرفوع
  },
  duration_seconds: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  VideoId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
}, {
  tableName: 'videoparts',
});

module.exports = VideoPart;
