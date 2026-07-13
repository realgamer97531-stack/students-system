require('dotenv').config({ path: '.env' });
const sequelize = require('./config/database');
(async () => {
  try {
    await sequelize.authenticate();
    console.log('DB OK');
    const qi = sequelize.getQueryInterface();
    const tables = await qi.showAllTables();
    console.log('TABLES', tables);
    const [results] = await sequelize.query("SHOW TABLES LIKE '%follow%';");
    console.log('FOLLOW TABLES', results);
    const FollowUpAssignment = require('./models/FollowUpAssignment');
    const User = require('./models/User');
    console.log('FollowUpAssignment model tableName =', FollowUpAssignment.getTableName());
    console.log('FollowUpAssignment model rawAttributes =', Object.keys(FollowUpAssignment.rawAttributes));
  } catch (err) {
    console.error('ERR', err);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
})();