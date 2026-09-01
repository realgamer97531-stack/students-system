const sequelize = require('./config/database');

async function check() {
  try {
    const queryInterface = sequelize.getQueryInterface();
    const tableInfo = await queryInterface.describeTable('sessions');
    
    console.log('\n=== SESSIONS TABLE COLUMNS ===');
    Object.keys(tableInfo).forEach(col => {
      if (col.includes('homework') || col.includes('exam') || col.includes('url')) {
        console.log(`✓ ${col}:`, tableInfo[col]);
      }
    });

    // Check if columns exist
    if (!tableInfo.homework_video_url) {
      console.log('\n❌ homework_video_url column MISSING');
    } else {
      console.log('\n✅ homework_video_url column EXISTS');
    }

    if (!tableInfo.exam_url) {
      console.log('❌ exam_url column MISSING');
    } else {
      console.log('✅ exam_url column EXISTS');
    }

    // Sample data check
    console.log('\n=== SAMPLE DATA CHECK ===');
    const [sessions] = await sequelize.query(
      'SELECT id, lesson_number, homework_video_url, exam_url FROM sessions LIMIT 5'
    );
    console.log('Sample sessions with URLs:');
    sessions.forEach(s => {
      console.log(`  ID ${s.id} (Lesson ${s.lesson_number}):`, {
        homework_video_url: s.homework_video_url ? '✓ SET' : '✗ NULL',
        exam_url: s.exam_url ? '✓ SET' : '✗ NULL'
      });
    });

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await sequelize.close();
  }
}

check();
