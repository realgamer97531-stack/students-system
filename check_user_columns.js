require('dotenv').config({ path: '.env' });
const sequelize = require('./config/database');
(async () => {
  try {
    await sequelize.authenticate();
    const [results] = await sequelize.query('SHOW COLUMNS FROM users;');
    console.log('COLUMNS', results);
  } catch (err) {
    console.error('ERR', err);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
})();