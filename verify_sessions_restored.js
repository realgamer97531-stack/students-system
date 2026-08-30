require('dotenv').config();
const sequelize = require('./config/database');
const Session = require('./models/Session');
const setupAssociations = require('./models/associations');

(async () => {
  try {
    await sequelize.authenticate();
    setupAssociations();
    
    const sessions = await Session.findAll({
      attributes: ['id', 'lesson_number', 'serial_number', 'status'],
      order: [['lesson_number', 'ASC'], ['serial_number', 'ASC']]
    });
    
    console.log('\n✅ ALL SESSIONS NOW IN DATABASE:');
    console.log('─────────────────────────────────────────');
    sessions.forEach(s => {
      const restored = [30, 38, 41, 43].includes(s.id) ? '🔄 RESTORED' : '✓ KEPT';
      console.log(`[${s.id}] Lesson ${s.lesson_number}, Serial ${s.serial_number} - ${restored}`);
    });
    console.log('─────────────────────────────────────────\n');
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
})();
