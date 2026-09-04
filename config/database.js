require('dotenv').config();
const { Sequelize } = require('sequelize');
const mysql2 = require('mysql2');

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'mysql',
    dialectModule: mysql2,
    connectTimeout: 20000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    retry: {
      max: 3,
      match: [/ETIMEDOUT/, /ECONNRESET/, /PROTOCOL_CONNECTION_LOST/],
    },
    logging: false,
    pool: {
      max: 3,       // Keep the connection footprint within hosted database limits
      min: 0,
      acquire: 30000,
      idle: 60000,
    },
  }
);

module.exports = sequelize;
