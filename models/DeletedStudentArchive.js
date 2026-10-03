const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// نسخة كاملة من أي طالب اتحذف (الطالب + حضوره + معاملاته + ...) قبل الحذف مباشرة،
// ومين اللي حذفه وإمتى. بتسمح بإرجاع الطالب تاني من صفحة "الطلاب المحذوفين".
const DeletedStudentArchive = sequelize.define('DeletedStudentArchive', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  student_id: { type: DataTypes.INTEGER, allowNull: false },
  student_code: { type: DataTypes.STRING, allowNull: true },
  student_name: { type: DataTypes.STRING, allowNull: true },
  data: { type: DataTypes.TEXT('long'), allowNull: false }, // JSON: { student, related: { ModelName: [rows] } }
  deleted_by_user_id: { type: DataTypes.INTEGER, allowNull: true },
  deleted_by_name: { type: DataTypes.STRING, allowNull: true },
  restored_at: { type: DataTypes.DATE, allowNull: true },
  restored_by_name: { type: DataTypes.STRING, allowNull: true },
}, {
  tableName: 'deleted_student_archive',
  indexes: [{ fields: ['student_id'] }],
});

module.exports = DeletedStudentArchive;
