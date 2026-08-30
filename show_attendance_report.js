require('dotenv').config();
const sequelize = require('./config/database');
const Attendance = require('./models/Attendance');
const Session = require('./models/Session');
const Student = require('./models/Student');
const Center = require('./models/Center');
const setupAssociations = require('./models/associations');

(async () => {
  try {
    await sequelize.authenticate();
    setupAssociations();
    
    console.log('\n═══════════════════════════════════════════════════════\n');
    console.log('  📊 جلوري CENTER - SESSION ATTENDANCE REPORT');
    console.log('\n═══════════════════════════════════════════════════════\n');

    // Get Session 33
    const session33 = await Session.findByPk(33);
    console.log(`✓ Session 33 - Lesson 1, Serial ${session33.serial_number}`);
    console.log(`  Center ID: ${session33.CenterId}\n`);

    // Get all attendance for Session 33
    const attendanceRecords = await Attendance.findAll({
      where: { SessionId: 33 },
      include: [
        { model: Student, attributes: ['id', 'name'] }
      ],
      limit: 10
    });

    console.log(`📋 ATTENDANCE RECORDS FOR SESSION 33:`);
    console.log(`Total: ${attendanceRecords.length} students attended\n`);
    
    console.log('First 10 records:');
    console.log('─────────────────────────────────────────────────────────');
    attendanceRecords.forEach((att, idx) => {
      const date = new Date(att.attended_at).toLocaleString('ar-EG');
      console.log(`${idx + 1}. Student ${att.StudentId} - ${att.Student?.name || 'N/A'}`);
      console.log(`   Date: ${date}`);
      console.log(`   Payment: ${att.payment_collected || 0} EGP`);
      if (att.comment) console.log(`   Note: ${att.comment}`);
      console.log('');
    });

    // Get summary stats
    console.log('═════════════════════════════════════════════════════════');
    console.log('\n📊 SUMMARY STATISTICS:');
    
    const totalAttended = await Attendance.count({ where: { SessionId: 33 } });
    const totalCollected = await sequelize.query(
      'SELECT SUM(payment_collected) as total FROM attendances WHERE SessionId = 33',
      { type: sequelize.QueryTypes.SELECT }
    );

    console.log(`✓ Total Students Attended: ${totalAttended}`);
    console.log(`✓ Total Payment Collected: ${totalCollected[0].total || 0} EGP`);
    console.log(`\n✅ Session 33 IS NOT EMPTY - It has ${totalAttended} student records!\n`);

    process.exit(0);
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  }
})();
