const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BookletReservation = sequelize.define('BookletReservation', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  payment_method: { type: DataTypes.ENUM('center', 'vodafone'), allowNull: false },
  transfer_image_url: { type: DataTypes.STRING, allowNull: true },
  transaction_reference: { type: DataTypes.STRING, allowNull: true, unique: true },
  status: { type: DataTypes.ENUM('pending', 'verified', 'rejected'), defaultValue: 'pending' },
  is_delivered: { type: DataTypes.BOOLEAN, defaultValue: false },
  delivered_at: { type: DataTypes.DATE, allowNull: true },
  paid_amount: { type: DataTypes.FLOAT, defaultValue: 0 },
  notes: { type: DataTypes.TEXT, allowNull: true },
  verified_by: { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = BookletReservation;