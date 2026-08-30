require('dotenv').config();
const sequelize = require('./config/database');
const Attendance = require('./models/Attendance');
const Session = require('./models/Session');
const setupAssociations = require('./models/associations');

(async () => {
  try {
    await sequelize.authenticate();
    setupAssociations();
    
    console.log('🔍 DETAILED ATTENDANCE CHECK FOR GLORY SESSIONS\n');

    // Get Session 33 (Lesson 1 for جلوري)
    const session33 = await Session.findByPk(33, {
      include: [Attendance]
    });

    if (!session33) {
      console.log('❌ Session 33 not found!');
      process.exit(1);
    }

    console.log(`Session 33 (Lesson 1 - جلوري):`);
    console.log(`  Attendance records in session: ${session33.Attendances?.length || 0}`);

    if (session33.Attendances && session33.Attendances.length > 0) {
      console.log(`  First 5 records:`);
      session33.Attendances.slice(0, 5).forEach(a => {
        console.log(`    [${a.id}] Student ${a.StudentId}: Present=${a.present}`);
      });
    }

    // Direct query to double-check
    const directCount = await Attendance.count({
      where: { SessionId: 33 }
    });
    console.log(`\n  Direct count from database: ${directCount}`);

    // Check Session 46 too
    const session46 = await Session.findByPk(46, {
      include: [Attendance]
    });

    if (session46) {
      console.log(`\nSession 46 (Lesson 3 - جلوري):`);
      console.log(`  Attendance records: ${session46.Attendances?.length || 0}`);
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  }
})();
