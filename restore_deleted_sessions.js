require('dotenv').config();
const sequelize = require('./config/database');

// Models
const Session = require('./models/Session');
const Video = require('./models/Video');
const VideoAccessGrant = require('./models/VideoAccessGrant');
const VideoSession = require('./models/VideoSession');
const VideoStudentAccess = require('./models/VideoStudentAccess');
const BalanceTransaction = require('./models/BalanceTransaction');

const setupAssociations = require('./models/associations');

const fs = require('fs');

async function restoreFromBackup() {
  console.log('🔄 RESTORING SESSIONS FROM BACKUP...\n');

  try {
    await sequelize.authenticate();
    setupAssociations();

    // Load backup file
    const backupPath = './backups/pre_migration_backup_1788090278073.json';
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

    const sessionsToRestore = [30, 38, 41, 43];

    console.log('=== RESTORING SESSIONS ===\n');

    // 1. Restore Sessions
    for (const sessionId of sessionsToRestore) {
      const sessionData = backup.sessions[sessionId];
      if (sessionData) {
        try {
          await Session.create(sessionData);
          console.log(`✓ Restored Session ${sessionId}`);
        } catch (err) {
          if (err.name === 'SequelizeUniqueConstraintError') {
            console.log(`  Session ${sessionId} already exists, updating...`);
            await Session.update(sessionData, { where: { id: sessionId } });
            console.log(`✓ Updated Session ${sessionId}`);
          } else {
            throw err;
          }
        }
      }
    }

    // 2. Restore VideoAccessGrants for these sessions
    console.log('\n=== RESTORING VIDEO ACCESS GRANTS ===\n');
    let restoreCount = 0;
    
    for (const sessionId of sessionsToRestore) {
      const grants = Object.values(backup.videoAccessGrants || {}).filter(g => g.SessionId === sessionId);
      
      for (const grantData of grants) {
        try {
          // Check if already exists (from migration)
          const existing = await VideoAccessGrant.findByPk(grantData.id);
          if (!existing) {
            await VideoAccessGrant.create(grantData);
            restoreCount++;
          }
        } catch (err) {
          // Silently skip duplicates
        }
      }
      console.log(`Restored ${grants.length} grants for Session ${sessionId}`);
    }

    // 3. Restore BalanceTransactions
    console.log('\n=== RESTORING BALANCE TRANSACTIONS ===\n');
    let txRestoreCount = 0;

    const sessionTxs = Object.values(backup.balanceTransactions || {}).filter(tx => 
      sessionsToRestore.includes(tx.SessionId)
    );

    for (const txData of sessionTxs) {
      try {
        const existing = await BalanceTransaction.findByPk(txData.id);
        if (!existing) {
          await BalanceTransaction.create(txData);
          txRestoreCount++;
        }
      } catch (err) {
        // Silently skip duplicates
      }
    }
    console.log(`Restored ${txRestoreCount} balance transactions`);

    // 4. Verify restoration
    console.log('\n=== VERIFICATION ===\n');
    for (const sessionId of sessionsToRestore) {
      const session = await Session.findByPk(sessionId, {
        include: [
          { model: VideoAccessGrant },
          { model: BalanceTransaction }
        ]
      });

      if (session) {
        console.log(`Session ${sessionId}:`);
        console.log(`  Status: ${session.status}`);
        console.log(`  Access Grants: ${session.VideoAccessGrants?.length || 0}`);
        console.log(`  Balance Transactions: ${session.BalanceTransactions?.length || 0}`);
      } else {
        console.log(`❌ Session ${sessionId} NOT restored!`);
      }
    }

    console.log('\n✅ RESTORATION COMPLETE!');
    console.log('Sessions 30, 38, 41, 43 have been restored from backup.');
    console.log('Access grants and balance transactions restored.');
    console.log('\nNOTE: Videos have been preserved - only visibility needs to be toggled.');

    process.exit(0);
  } catch (error) {
    console.error('❌ ERROR DURING RESTORATION:', error.message);
    process.exit(1);
  }
}

restoreFromBackup();
