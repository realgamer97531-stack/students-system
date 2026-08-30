require('dotenv').config();
const sequelize = require('./config/database');
const fs = require('fs');
const path = require('path');

// Models
const Session = require('./models/Session');
const VideoAccessGrant = require('./models/VideoAccessGrant');
const BalanceTransaction = require('./models/BalanceTransaction');
const Student = require('./models/Student');

const setupAssociations = require('./models/associations');

async function createPreMigrationBackup() {
  console.log('🔒 CREATING PRE-MIGRATION BACKUP...\n');

  try {
    await sequelize.authenticate();
    setupAssociations();

    // Backup all relevant data
    const backup = {
      timestamp: new Date().toISOString(),
      sessions: {},
      videoAccessGrants: {},
      balanceTransactions: {},
      onlineStudents: {}
    };

    // Backup sessions
    console.log('  Backing up sessions...');
    const sessions = await Session.findAll({
      attributes: ['id', 'lesson_number', 'serial_number', 'status', 'cost_per_normal', 'cost_per_reduced']
    });
    sessions.forEach(s => {
      backup.sessions[s.id] = s.toJSON();
    });

    // Backup video access grants
    console.log('  Backing up video access grants...');
    const grants = await VideoAccessGrant.findAll();
    grants.forEach(g => {
      backup.videoAccessGrants[g.id] = g.toJSON();
    });

    // Backup balance transactions
    console.log('  Backing up balance transactions...');
    const transactions = await BalanceTransaction.findAll({
      include: [{ model: Student, attributes: ['id', 'name'] }]
    });
    transactions.forEach(t => {
      backup.balanceTransactions[t.id] = {
        id: t.id,
        StudentId: t.StudentId,
        amount: t.amount,
        SessionId: t.SessionId,
        reason: t.reason,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      };
    });

    // Backup online students
    console.log('  Backing up online student data...');
    const onlineStudents = await Student.findAll({
      include: [{ model: require('./models/Center'), attributes: ['id', 'name'] }]
    });
    const online = onlineStudents.filter(s => 
      s.Center?.name?.toLowerCase().includes('online')
    );
    online.forEach(s => {
      backup.onlineStudents[s.id] = {
        id: s.id,
        name: s.name,
        balance: s.balance,
        CenterId: s.CenterId
      };
    });

    // Save backup
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir);
    }

    const backupPath = path.join(backupDir, `pre_migration_backup_${Date.now()}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));

    console.log(`\n✅ Pre-migration backup created: ${backupPath}`);
    console.log(`   Sessions backed up: ${Object.keys(backup.sessions).length}`);
    console.log(`   Access grants backed up: ${Object.keys(backup.videoAccessGrants).length}`);
    console.log(`   Transactions backed up: ${Object.keys(backup.balanceTransactions).length}`);
    console.log(`   Online students backed up: ${Object.keys(backup.onlineStudents).length}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Backup failed:', error.message);
    process.exit(1);
  }
}

createPreMigrationBackup();
