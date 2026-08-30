require('dotenv').config();
const sequelize = require('./config/database');
const Attendance = require('./models/Attendance');
const setupAssociations = require('./models/associations');
const fs = require('fs');

(async () => {
  try {
    await sequelize.authenticate();
    setupAssociations();
    
    console.log('📥 EXTRACTING ATTENDANCE DATA FROM SQL BACKUP\n');

    // Read the SQL backup file
    const sqlBackupPath = './backups/backup_2026-06-30T10-25-52-340Z.sql';
    const sqlContent = fs.readFileSync(sqlBackupPath, 'utf8');

    // Extract attendance INSERT statements
    const insertPattern = /INSERT INTO `attendances` VALUES \((.*?)\);/gs;
    let matches;
    const attendanceRecords = [];
    let recordCount = 0;

    console.log('🔍 Parsing SQL backup...');
    
    while ((matches = insertPattern.exec(sqlContent)) !== null) {
      const valuesStr = matches[1];
      
      // Split multiple row inserts (some INSERT statements have multiple rows)
      const rows = valuesStr.split('),(');
      
      for (let row of rows) {
        recordCount++;
        // Remove parentheses and parse values
        row = row.replace(/^\(/, '').replace(/\)$/, '');
        
        const values = row.split(',').map(v => {
          v = v.trim();
          // Handle NULL, strings, and numbers
          if (v === 'NULL') return null;
          if (v.startsWith("'") && v.endsWith("'")) {
            return v.slice(1, -1);
          }
          // Try to parse as number
          if (!isNaN(v) && v !== '') return parseInt(v);
          return v;
        });

        if (values.length >= 8) {
          attendanceRecords.push({
            id: values[0],
            StudentId: values[1],
            SessionId: values[2],
            present: values[3],
            notes: values[4] || null,
            createdAt: values[5] ? new Date(values[5]) : new Date(),
            updatedAt: values[6] ? new Date(values[6]) : new Date(),
            CenterId: values[7]
          });
        }
      }
    }

    console.log(`✓ Found ${recordCount} attendance records in backup`);

    if (attendanceRecords.length === 0) {
      console.log('❌ No attendance records found in backup!');
      process.exit(1);
    }

    // Filter for جلوري center sessions (Center ID 1)
    const gloryAttendances = attendanceRecords.filter(a => a.CenterId === 1);
    console.log(`\n🎯 Found ${gloryAttendances.length} records for جلوري (Center ID: 1)`);

    // Group by session
    const bySession = {};
    gloryAttendances.forEach(a => {
      if (!bySession[a.SessionId]) bySession[a.SessionId] = [];
      bySession[a.SessionId].push(a);
    });

    console.log('\nAttendance records by session:');
    for (const sessionId in bySession) {
      console.log(`  Session ${sessionId}: ${bySession[sessionId].length} records`);
    }

    // Restore attendance records
    console.log('\n📝 Restoring attendance records...');
    let restored = 0;
    let skipped = 0;

    for (const record of gloryAttendances) {
      try {
        const existing = await Attendance.findByPk(record.id);
        if (!existing) {
          await Attendance.create(record);
          restored++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.log(`  Error restoring record ${record.id}: ${err.message}`);
      }
    }

    console.log(`✅ Restored: ${restored} records`);
    console.log(`⏭️  Skipped: ${skipped} records (already exist)`);

    console.log('\n✨ Attendance restoration complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  }
})();
