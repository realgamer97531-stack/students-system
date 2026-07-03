const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PaymentVerification = sequelize.define('PaymentVerification', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  StudentId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  amount: {
    type: DataTypes.FLOAT,
    allowNull: false,
  },
  recipientNumber: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  recipientName: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  senderNumber: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  transactionDate: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  transactionTime: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // الفيصل الحقيقي في منع الاحتيال: رقم العملية لازم يكون فريد على مستوى قاعدة البيانات نفسها،
  // مش بس على مستوى فحص الكود، عشان يستحيل تسجيل نفس التحويل مرتين حتى لو حصل تزامن.
  transactionReference: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  paymentMethod: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('approved', 'rejected'),
    allowNull: false,
  },
  rejectionReason: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  imagePath: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // نص استجابة الذكاء الاصطناعي كاملاً، بيفيد وقت المراجعة اليدوية لو حصل خلاف
  aiRawResponse: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'paymentverifications',
});

module.exports = PaymentVerification;