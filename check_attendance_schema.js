require('dotenv').config();
const sequelize = require('./config/database');
const Attendance = require('./models/Attendance');
const setupAssociations = require('./models/associations');

(async () => {
  try {
    await sequelize.authenticate();
    setupAssociations();
    
    console.log('🔍 CHECKING ATTENDANCE RECORD DETAILS\n');

    // Get raw records to see all fields
    const records = await sequelize.query(
      'SELECT * FROM attendances WHERE SessionId = 33 LIMIT 5',
      { type: sequelize.QueryTypes.SELECT }
    );

    console.log('Raw Attendance Records from Session 33:');
    records.forEach((r, idx) => {
      console.log(`\nRecord ${idx + 1}:`);
      console.log(JSON.stringify(r, null, 2));
    });

    // Check the table schema
    console.log('\n\n📋 ATTENDANCE TABLE SCHEMA:');
    const schema = await sequelize.query(
      "DESCRIBE attendances",
      { type: sequelize.QueryTypes.SELECT }
    );
    
    schema.forEach(col => {
      console.log(`  ${col.Field}: ${col.Type}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  }
})();
