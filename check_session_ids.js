require('dotenv').config();
const sequelize = require('./config/database');
const Session = require('./models/Session');
const setupAssociations = require('./models/associations');

(async () => {
  try {
    await sequelize.authenticate();
    setupAssociations();
    
    // Get raw session data to see SubjectId and CenterId
    const sessions = await Session.findAll({
      attributes: ['id', 'lesson_number', 'serial_number', 'SubjectId', 'CenterId', 'status'],
      where: { id: [30, 38, 41, 43] },
      raw: true
    });
    
    console.log('\n📊 CURRENT SESSION DATA:');
    console.log('─────────────────────────────────────────');
    sessions.forEach(s => {
      console.log(`Session ${s.id}:`);
      console.log(`  SubjectId: ${s.SubjectId}`);
      console.log(`  CenterId: ${s.CenterId}`);
    });
    
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
})();
