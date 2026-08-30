require('dotenv').config();
const sequelize = require('./config/database');
const Session = require('./models/Session');
const setupAssociations = require('./models/associations');

(async () => {
  try {
    await sequelize.authenticate();
    setupAssociations();
    
    // Get all sessions with their IDs to find pattern
    const allSessions = await Session.findAll({
      attributes: ['id', 'lesson_number', 'serial_number', 'SubjectId', 'CenterId'],
      order: [['lesson_number', 'ASC'], ['serial_number', 'ASC']],
      raw: true
    });
    
    console.log('\n📊 ALL SESSIONS - Find pattern:');
    console.log('─────────────────────────────────────────');
    
    // Group by lesson
    const byLesson = {};
    allSessions.forEach(s => {
      if (!byLesson[s.lesson_number]) {
        byLesson[s.lesson_number] = [];
      }
      byLesson[s.lesson_number].push(s);
    });
    
    for (const lesson in byLesson) {
      console.log(`\nLesson ${lesson}:`);
      byLesson[lesson].forEach(s => {
        const marker = [30, 38, 41, 43].includes(s.id) ? '❌ MISSING IDs' : '✓';
        console.log(`  [${s.id}] Serial ${s.serial_number} - SubjectId: ${s.SubjectId}, CenterId: ${s.CenterId} ${marker}`);
      });
    }
    
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
})();
