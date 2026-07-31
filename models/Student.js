const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Student = sequelize.define('Student', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_code: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: true, // هنولّده بعد إنشاء الطالب مباشرة
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  parent_phone: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  price_per_session: {
    type: DataTypes.FLOAT,
    allowNull: false,
  },
  balance: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
  },
  admin_note: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  is_blocked: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  points: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  booklet_status: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false, // false = لسه ماشتراهوش
  },
  profile_photo_url: {
    type: DataTypes.STRING(500),
    allowNull: true,
  },
}, {
  tableName: 'students',
  hooks: {
    // بعد إنشاء الطالب مباشرة، نولّد له كود تلقائي بناءً على الـ id بتاعه
    afterCreate: async (student) => {
      const code = `STU-${String(student.id).padStart(5, '0')}`; // مثال: STU-00001
      student.student_code = code;
      await student.save();
    },
  },
});

module.exports = Student;
