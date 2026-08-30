require('dotenv').config();
const sequelize = require('./config/database');
const Session = require('./models/Session');
const Center = require('./models/Center');
const Attendance = require('./models/Attendance');
const setupAssociations = require('./models/associations');

(async () => {
  try {
    await sequelize.authenticate();
    setupAssociations();
    
    console.log('🔍 CHECKING جلوري (GLORY) SESSIONS\n');

    // Find center by name
    const centers = await Center.findAll({ attributes: ['id', 'name'] });
    console.log('Available Centers:');
    centers.forEach(c => console.log(`  [${c.id}] ${c.name}`));

    // Find جلوري center
    const gloryCenters = await Center.findAll({
      where: { name: 'جلوري' }
    });

    if (gloryCenters.length === 0) {
      console.log('\n❌ No center named "جلوري" found');
      process.exit(1);
    }

    const gloryId = gloryCenters[0].id;
    console.log(`\n✓ Found جلوري Center with ID: ${gloryId}`);

    // Find all sessions for this center
    const glorySessions = await Session.findAll({
      where: { CenterId: gloryId },
      include: [
        { model: Center },
        { model: Attendance }
      ]
    });

    console.log(`\n📊 GLORY SESSIONS:`);
    glorySessions.forEach(s => {
      console.log(`  [${s.id}] Lesson ${s.lesson_number}, Serial ${s.serial_number}`);
      console.log(`      Attendance records: ${s.Attendances?.length || 0}`);
    });

    // Check session 1 specifically
    console.log(`\n🔎 CHECKING SESSION 1 FOR GLORY:`);
    const session1 = await Session.findByPk(1, {
      include: [
        { model: Center },
        { model: Attendance }
      ]
    });

    if (session1) {
      console.log(`  Center: ${session1.Center?.name}`);
      console.log(`  Attendance records: ${session1.Attendances?.length || 0}`);
    }

    process.exit(0);
  } catch(e) {
    console.error('❌ ERROR:', e.message);
    process.exit(1);
  }
})();
