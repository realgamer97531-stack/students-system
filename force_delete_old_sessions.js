require('dotenv').config();
const sequelize = require('./config/database');

// Models
const Session = require('./models/Session');
const VideoAccessGrant = require('./models/VideoAccessGrant');
const Video = require('./models/Video');
const VideoSession = require('./models/VideoSession');
const VideoStudentAccess = require('./models/VideoStudentAccess');
const BalanceTransaction = require('./models/BalanceTransaction');

const setupAssociations = require('./models/associations');

const fs = require('fs');
const path = require('path');

async function main() {
  console.log('🔍 CHECKING AND DELETING OLD SESSIONS\n');

  try {
    await sequelize.authenticate();
    setupAssociations();

    const sessionsToDelete = [30, 38, 41, 43];

    // Check status of all sessions
    console.log('=== SESSION STATUS CHECK ===');
    for (const id of sessionsToDelete) {
      const session = await Session.findByPk(id, {
        include: [
          { model: Video },
          { model: VideoAccessGrant },
          { model: BalanceTransaction }
        ]
      });

      if (session) {
        console.log(`\nSession ${id}:`);
        console.log(`  Status: ${session.status}`);
        console.log(`  Lesson: ${session.lesson_number}`);
        console.log(`  Videos: ${session.Videos?.length || 0}`);
        console.log(`  Access Grants: ${session.VideoAccessGrants?.length || 0}`);
        console.log(`  Balance Transactions: ${session.BalanceTransactions?.length || 0}`);
      } else {
        console.log(`Session ${id}: NOT FOUND`);
      }
    }

    // Force delete old sessions
    console.log('\n=== FORCE DELETING OLD SESSIONS ===');
    for (const sessionId of sessionsToDelete) {
      const session = await Session.findByPk(sessionId);
      if (session) {
        // Delete in correct order due to foreign keys:
        const videos = await Video.findAll({ where: { SessionId: sessionId } });
        
        // 1. Delete ALL VideoStudentAccess entries for videos in this session
        for (const video of videos) {
          await VideoStudentAccess.destroy({ where: { VideoId: video.id } });
        }
        console.log(`  Deleted VideoStudentAccess entries for Session ${sessionId}`);

        // 2. Delete ALL VideoSession entries for this session (not just the videos)
        await VideoSession.destroy({ where: { SessionId: sessionId } });
        console.log(`  Deleted VideoSession entries for Session ${sessionId}`);

        // 3. Delete BalanceTransactions
        await BalanceTransaction.destroy({ where: { SessionId: sessionId } });
        console.log(`  Deleted balance transactions for Session ${sessionId}`);

        // 4. Delete VideoAccessGrants
        await VideoAccessGrant.destroy({ where: { SessionId: sessionId } });
        console.log(`  Deleted access grants for Session ${sessionId}`);

        // 5. Delete Videos
        await Video.destroy({ where: { SessionId: sessionId } });
        console.log(`  Deleted videos for Session ${sessionId}`);

        // 6. Delete Session
        await session.destroy();
        console.log(`  ✓ Deleted Session ${sessionId}`);
      }
    }

    console.log('\n=== FINAL VERIFICATION ===');
    console.log('Checking remaining sessions...');

    // List all remaining sessions
    const remainingSessions = await Session.findAll({
      attributes: ['id', 'lesson_number', 'serial_number', 'status'],
      order: [['lesson_number', 'ASC'], ['serial_number', 'ASC']]
    });

    console.log('\nRemaining sessions:');
    remainingSessions.forEach(s => {
      console.log(`  [${s.id}] Lesson ${s.lesson_number}, Serial ${s.serial_number}, Status: ${s.status}`);
    });

    console.log('\n✅ All old center sessions deleted!');
    console.log('📱 Students will now see ONLY merged online sessions (44 & 45)');

    process.exit(0);
  } catch (error) {
    console.error('❌ ERROR:', error);
    process.exit(1);
  }
}

main();
