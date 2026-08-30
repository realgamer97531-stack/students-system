require('dotenv').config();
const sequelize = require('./config/database');
const Session = require('./models/Session');
const setupAssociations = require('./models/associations');

(async () => {
  try {
    await sequelize.authenticate();
    setupAssociations();
    
    console.log('🔧 SETTING SUBJECT AND CENTER IDs FOR RESTORED SESSIONS\n');

    // Map based on the corresponding online sessions
    const mappings = [
      { id: 30, subjectId: 4, centerId: 12 }, // Lesson 1 center → match Session 44 (online)
      { id: 38, subjectId: 4, centerId: 12 }, // Lesson 2 center → match Session 45 (online)
      { id: 41, subjectId: 4, centerId: 12 }, // Lesson 2 center → match Session 45 (online)
      { id: 43, subjectId: 4, centerId: 12 }, // Lesson 2 center → match Session 45 (online)
    ];

    for (const mapping of mappings) {
      await Session.update(
        { SubjectId: mapping.subjectId, CenterId: mapping.centerId },
        { where: { id: mapping.id } }
      );
      console.log(`✓ Session ${mapping.id}: SubjectId=${mapping.subjectId}, CenterId=${mapping.centerId}`);
    }

    // Verify
    console.log('\n📊 VERIFICATION:');
    const sessions = await Session.findAll({
      attributes: ['id', 'lesson_number', 'SubjectId', 'CenterId'],
      where: { id: [30, 38, 41, 43] }
    });
    
    sessions.forEach(s => {
      console.log(`Session ${s.id}: SubjectId=${s.SubjectId}, CenterId=${s.CenterId} ✓`);
    });

    console.log('\n✅ All sessions now have proper associations!');
    process.exit(0);
  } catch(e) {
    console.error('❌ ERROR:', e.message);
    process.exit(1);
  }
})();
