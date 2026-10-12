const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// طالب اتشال من فيديو معين بالذات (حتى لو مجموعته عندها الفيديو). الجدول بيتعمل في ensureLessonAccessSchema
const VideoStudentBlock = sequelize.define('VideoStudentBlock', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  VideoId: { type: DataTypes.INTEGER, allowNull: false },
  StudentId: { type: DataTypes.INTEGER, allowNull: false },
}, {
  tableName: 'video_student_blocks',
});

module.exports = VideoStudentBlock;
