require('dotenv').config();
const sequelize = require('./config/database');
const { Op } = require('sequelize');

// Models
const Session = require('./models/Session');
const VideoAccessGrant = require('./models/VideoAccessGrant');
const BalanceTransaction = require('./models/BalanceTransaction');
const Student = require('./models/Student');
const Video = require('./models/Video');

const setupAssociations = require('./models/associations');

const fs = require('fs');
const path = require('path');

const report = {
  timestamp: new Date().toISOString(),
  sessionsDeleted: [],
  viewsFixed: [],
  balanceChanges: [],
  errors: []
};

async function main() {
  console.log('🔧 FIXING SESSION MERGE ISSUES\n');

  try {
    await sequelize.authenticate();
    console.log('✅ Database connected\n');
    setupAssociations();

    // STEP 1: Delete old center sessions that were marked as cancelled
    console.log('=== DELETING OLD CENTER SESSIONS ===');
    const sessionsToDelete = [30, 38, 41, 43]; // Old center sessions
    
    for (const sessionId of sessionsToDelete) {
      const session = await Session.findByPk(sessionId);
      if (session && session.status === 'cancelled') {
        // Get session info before deletion
        const sessionInfo = {
          id: session.id,
          lesson_number: session.lesson_number,
          serial_number: session.serial_number,
          status: session.status
        };

        // Delete all related VideoAccessGrants for this session
        const grantsToDelete = await VideoAccessGrant.findAll({
          where: { SessionId: sessionId }
        });
        console.log(`  Session ${sessionId}: Deleting ${grantsToDelete.length} access grants...`);
        
        for (const grant of grantsToDelete) {
          await grant.destroy();
        }

        // Delete all Videos associated with this session
        const videos = await Video.findAll({
          where: { SessionId: sessionId }
        });
        console.log(`  Session ${sessionId}: Deleting ${videos.length} videos...`);
        
        for (const video of videos) {
          await video.destroy();
        }

        // Delete the session itself
        await session.destroy();
        
        report.sessionsDeleted.push(sessionInfo);
        console.log(`  ✓ Deleted Session ${sessionId}`);
      }
    }

    // STEP 2: Fix the 999 views issue
    console.log('\n=== FIXING 999 VIEWS ISSUE ===');
    const badGrants = await VideoAccessGrant.findAll({
      where: { max_views: 999 }
    });

    console.log(`Found ${badGrants.length} grants with 999 views`);
    for (const grant of badGrants) {
      console.log(`  Fixing: Student ${grant.StudentId}, Session ${grant.SessionId}`);
      await grant.update({ max_views: 3 }); // Set to normal paid view count
      
      report.viewsFixed.push({
        grantId: grant.id,
        studentId: grant.StudentId,
        sessionId: grant.SessionId,
        oldViews: 999,
        newViews: 3
      });
    }

    console.log(`  ✓ Fixed ${badGrants.length} grants`);

    // STEP 3: Verify sessions 44 and 45 exist
    console.log('\n=== VERIFYING ONLINE SESSIONS ===');
    const session44 = await Session.findByPk(44);
    const session45 = await Session.findByPk(45);
    
    console.log(`  Session 44: ${session44?.status} - Lesson ${session44?.lesson_number}`);
    console.log(`  Session 45: ${session45?.status} - Lesson ${session45?.lesson_number}`);

    // Get access grant counts for verification
    const grants44 = await VideoAccessGrant.count({
      where: { SessionId: 44 }
    });
    const grants45 = await VideoAccessGrant.count({
      where: { SessionId: 45 }
    });
    
    console.log(`  ✓ Session 44 has ${grants44} students with access`);
    console.log(`  ✓ Session 45 has ${grants45} students with access`);

    // STEP 4: Export balance changes detail
    console.log('\n=== EXPORTING BALANCE DETAIL ===');
    const allTransactions = await BalanceTransaction.findAll({
      include: [
        { model: Student, attributes: ['id', 'name'] },
        { model: Session, attributes: ['id', 'lesson_number'] }
      ],
      order: [['createdAt', 'DESC']],
      limit: 500 // Recent changes only
    });

    const balanceDetail = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalTransactions: allTransactions.length,
        sessionsAffected: sessionsToDelete.length,
        grantsFixed: badGrants.length
      },
      transactions: allTransactions.map(t => ({
        id: t.id,
        studentId: t.StudentId,
        studentName: t.Student?.name || 'N/A',
        amount: t.amount,
        sessionId: t.SessionId,
        lessonNumber: t.Session?.lesson_number || 'N/A',
        reason: t.reason,
        date: t.createdAt
      }))
    };

    const balanceReportPath = path.join(__dirname, `balance_detail_${Date.now()}.json`);
    fs.writeFileSync(balanceReportPath, JSON.stringify(balanceDetail, null, 2));
    console.log(`  ✓ Balance detail exported to: ${balanceReportPath}`);

    // STEP 5: Generate final report
    console.log('\n=== GENERATING FIX REPORT ===');
    
    const fixReport = {
      ...report,
      summary: {
        sessionsDeleted: report.sessionsDeleted.length,
        accessGrantsDeleted: sessionsToDelete.reduce((sum, id) => {
          return sum + (report.sessionsDeleted.find(s => s.id === id) ? 1 : 0);
        }, 0),
        viewsFixed: report.viewsFixed.length,
        balanceDetailExported: true
      }
    };

    const reportPath = path.join(__dirname, `fix_report_${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(fixReport, null, 2));

    // Print summary
    console.log('\n' + '='.repeat(70));
    console.log('✅ SESSION MERGE FIX COMPLETE');
    console.log('='.repeat(70));
    console.log('\nFIX SUMMARY:');
    console.log(`  • Old Sessions Deleted: ${report.sessionsDeleted.length}`);
    console.log(`  • Views Fixed (999 → 3): ${report.viewsFixed.length}`);
    console.log(`  • Session 44 Students: ${grants44}`);
    console.log(`  • Session 45 Students: ${grants45}`);
    console.log(`\n📊 Reports Generated:`);
    console.log(`  • Balance Detail: ${balanceReportPath}`);
    console.log(`  • Fix Report: ${reportPath}`);
    console.log('\n✨ Students will now see ONLY merged lectures (44 & 45)');
    console.log('='.repeat(70));

    process.exit(0);
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    report.errors.push(error.message);
    const errorPath = path.join(__dirname, `fix_error_${Date.now()}.json`);
    fs.writeFileSync(errorPath, JSON.stringify(report, null, 2));
    console.error(`Error report saved: ${errorPath}`);
    process.exit(1);
  }
}

main();
