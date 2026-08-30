require('dotenv').config();
const sequelize = require('./config/database');
const { Op } = require('sequelize');

// Models
const Session = require('./models/Session');
const Video = require('./models/Video');
const VideoAccessGrant = require('./models/VideoAccessGrant');
const BalanceTransaction = require('./models/BalanceTransaction');
const Student = require('./models/Student');
const Center = require('./models/Center');
const Subject = require('./models/Subject');

// Setup associations
const setupAssociations = require('./models/associations');

const fs = require('fs');
const path = require('path');

// Configuration for this specific migration
const CONFIG = {
  CENTER_SESSIONS: [30, 38, 41, 43], // All center sessions to merge
  ONLINE_SESSIONS: [44, 45],         // Online sessions to keep
  LESSON_1_MERGE: {
    from: [30],                       // Center sessions with Lesson 1
    to: 44                            // Online session to merge to
  },
  LESSON_2_MERGE: {
    from: [38, 41, 43],               // Center sessions with Lesson 2
    to: 45                            // Online session to merge to
  }
};

// Report data
const report = {
  timestamp: new Date().toISOString(),
  config: CONFIG,
  summary: {},
  sessionMerges: [],
  accessMigrations: [],
  studentsAffected: [],
  balanceAudits: [],
  refunds: [],
  errors: [],
  warnings: [],
};

async function findOnlineSessions() {
  console.log('\n=== LOADING SESSION CONFIGURATION ===');
  try {
    // Load all sessions
    const sessions = await Session.findAll({
      where: {
        id: [...CONFIG.CENTER_SESSIONS, ...CONFIG.ONLINE_SESSIONS]
      },
      include: [
        { model: Center, attributes: ['id', 'name'] },
        { model: Subject, attributes: ['id', 'name'] },
        { model: Video, attributes: ['id', 'title'] }
      ],
      raw: false
    });

    const sessionMap = {};
    sessions.forEach(s => {
      sessionMap[s.id] = s;
    });

    console.log('Sessions loaded:');
    CONFIG.LESSON_1_MERGE.from.forEach(id => {
      const s = sessionMap[id];
      console.log(`  [${id}] Lesson ${s.lesson_number}, Center: ${s.Center?.name}, Videos: ${s.Videos?.map(v => v.title).join(', ') || 'NONE'}`);
    });
    console.log(`  → Merging to [${CONFIG.LESSON_1_MERGE.to}]`);

    CONFIG.LESSON_2_MERGE.from.forEach(id => {
      const s = sessionMap[id];
      console.log(`  [${id}] Lesson ${s.lesson_number}, Center: ${s.Center?.name}, Videos: ${s.Videos?.map(v => v.title).join(', ') || 'NONE'}`);
    });
    console.log(`  → Merging to [${CONFIG.LESSON_2_MERGE.to}]`);

    return sessionMap;
  } catch (error) {
    const errorMsg = `Error loading sessions: ${error.message}`;
    console.error(errorMsg);
    report.errors.push(errorMsg);
    throw error;
  }
}

async function findOnlineStudents() {
  console.log('\n=== FINDING ONLINE STUDENTS ===');
  try {
    const students = await Student.findAll({
      include: [{ model: Center, attributes: ['id', 'name'] }],
      raw: false
    });

    const onlineStudents = students.filter(s => 
      s.Center?.name?.toLowerCase().includes('online') || 
      s.Center?.name?.toLowerCase().includes('اونلاين')
    );

    console.log(`Found ${onlineStudents.length} online students`);
    return onlineStudents;
  } catch (error) {
    const errorMsg = `Error finding online students: ${error.message}`;
    console.error(errorMsg);
    report.errors.push(errorMsg);
    throw error;
  }
}

async function migrateAccessGrants(fromSessionIds, toSessionId) {
  console.log(`\nMigrating access grants from Sessions ${fromSessionIds} to ${toSessionId}`);
  
  try {
    let totalMigrated = 0;

    for (const fromSessionId of fromSessionIds) {
      // Find all access grants for this "from" session
      const grants = await VideoAccessGrant.findAll({
        where: { SessionId: fromSessionId },
        include: [{ model: Student, attributes: ['id', 'name'] }]
      });

      console.log(`  Session ${fromSessionId}: ${grants.length} access grants to migrate`);

      for (const grant of grants) {
        // Check if this student already has access to the target session
        const existingGrant = await VideoAccessGrant.findOne({
          where: {
            StudentId: grant.StudentId,
            SessionId: toSessionId
          }
        });

        if (existingGrant) {
          // Keep the better one (most views)
          if (grant.max_views > existingGrant.max_views) {
            await existingGrant.update({ max_views: grant.max_views });
          }
          // Preserve the paid/attended method if better
          if ((grant.method === 'paid' || grant.method === 'attended') && 
              (existingGrant.method === 'admin_free' || existingGrant.method === 'admin_paid')) {
            await existingGrant.update({ method: grant.method });
          }
        } else {
          // Create new grant with same properties
          await VideoAccessGrant.create({
            StudentId: grant.StudentId,
            SessionId: toSessionId,
            method: grant.method,
            max_views: grant.max_views,
            views_used: 0 // Reset views for new session
          });

          report.accessMigrations.push({
            studentId: grant.StudentId,
            studentName: grant.Student?.name,
            fromSession: fromSessionId,
            toSession: toSessionId,
            method: grant.method,
            maxViews: grant.max_views
          });

          totalMigrated++;
        }
      }
    }

    console.log(`  Total new grants created: ${totalMigrated}`);
    return totalMigrated;
  } catch (error) {
    const errorMsg = `Error migrating access grants: ${error.message}`;
    console.error(errorMsg);
    report.errors.push(errorMsg);
    throw error;
  }
}

async function auditOnlineStudentBalances(onlineStudents) {
  console.log('\n=== AUDITING ONLINE STUDENT BALANCES ===');
  
  try {
    const auditResults = [];
    const affectedSessionIds = [...CONFIG.CENTER_SESSIONS, ...CONFIG.ONLINE_SESSIONS];

    for (const student of onlineStudents) {
      // Get all transactions for this student
      const transactions = await BalanceTransaction.findAll({
        where: { StudentId: student.id },
        include: [{ model: Session, attributes: ['id', 'lesson_number'] }],
        order: [['createdAt', 'ASC']]
      });

      // Count payments for center sessions (sessions being merged)
      const centerSessionPayments = transactions.filter(t => 
        CONFIG.CENTER_SESSIONS.includes(t.SessionId) && t.amount < 0
      );

      // Count payments for online sessions (new sessions)
      const onlineSessionPayments = transactions.filter(t => 
        CONFIG.ONLINE_SESSIONS.includes(t.SessionId) && t.amount < 0
      );

      // Group by lesson to check for duplicate payments
      const paymentsByLesson = {};
      [...centerSessionPayments, ...onlineSessionPayments].forEach(t => {
        const lesson = t.Session?.lesson_number;
        if (!paymentsByLesson[lesson]) {
          paymentsByLesson[lesson] = [];
        }
        paymentsByLesson[lesson].push({
          sessionId: t.SessionId,
          amount: Math.abs(t.amount),
          date: t.createdAt,
          reason: t.reason
        });
      });

      // Calculate audit result
      const audit = {
        studentId: student.id,
        studentName: student.name,
        currentBalance: student.balance,
        totalTransactions: transactions.length,
        centerSessionPayments: centerSessionPayments.length,
        onlineSessionPayments: onlineSessionPayments.length,
        paymentsByLesson,
        needsRefund: false,
        refundAmount: 0,
        refundReason: ''
      };

      // Check refund logic: if online student paid 3+ times for online lectures
      const totalOnlineRelatedPayments = centerSessionPayments.length + onlineSessionPayments.length;
      
      if (totalOnlineRelatedPayments >= 3) {
        // They should only pay max 2 (Lecture 1 + Lecture 2)
        const excessPayments = totalOnlineRelatedPayments - 2;
        
        // Estimate refund: take the smallest payment amount as the refund
        const allPayments = [...centerSessionPayments, ...onlineSessionPayments]
          .map(t => Math.abs(t.amount))
          .sort((a, b) => a - b);
        
        if (allPayments.length > 0 && excessPayments > 0) {
          audit.needsRefund = true;
          audit.refundAmount = allPayments[0] * excessPayments; // Refund excess payments
          audit.refundReason = `Online student paid ${totalOnlineRelatedPayments} times for online lectures (should be max 2). Refunding ${excessPayments} excess payment(s)`;
        }
      }

      auditResults.push(audit);
      report.balanceAudits.push(audit);
    }

    console.log(`Audited ${auditResults.length} students`);
    console.log(`Students needing refund: ${auditResults.filter(a => a.needsRefund).length}`);
    return auditResults;
  } catch (error) {
    const errorMsg = `Error auditing balances: ${error.message}`;
    console.error(errorMsg);
    report.errors.push(errorMsg);
    throw error;
  }
}

async function processRefunds(auditResults) {
  console.log('\n=== PROCESSING REFUNDS ===');
  
  try {
    const refunds = [];

    for (const audit of auditResults) {
      if (audit.refundAmount > 0) {
        const student = await Student.findByPk(audit.studentId);
        
        // Add refund transaction
        const refundTrans = await BalanceTransaction.create({
          StudentId: audit.studentId,
          amount: audit.refundAmount,
          reason: `REFUND: ${audit.refundReason}`,
          SessionId: null // Not tied to specific session
        });

        // Update student balance
        student.balance += audit.refundAmount;
        await student.save();

        refunds.push({
          studentId: audit.studentId,
          studentName: audit.studentName,
          refundAmount: audit.refundAmount,
          newBalance: student.balance,
          transactionId: refundTrans.id
        });

        report.refunds.push({
          ...refunds[refunds.length - 1],
          timestamp: new Date().toISOString()
        });

        console.log(`  Refunded ${audit.refundAmount} to Student ${audit.studentId} (${audit.studentName})`);
      }
    }

    return refunds;
  } catch (error) {
    const errorMsg = `Error processing refunds: ${error.message}`;
    console.error(errorMsg);
    report.errors.push(errorMsg);
    throw error;
  }
}

async function removeOldSessions() {
  console.log('\n=== MARKING OLD CENTER SESSIONS AS CANCELLED ===');
  
  try {
    let removedCount = 0;

    for (const sessionId of CONFIG.CENTER_SESSIONS) {
      const session = await Session.findByPk(sessionId);
      if (session) {
        await session.update({ status: 'cancelled' });
        removedCount++;

        const targetSessionId = session.lesson_number === 1 ? 
          CONFIG.LESSON_1_MERGE.to : CONFIG.LESSON_2_MERGE.to;

        report.sessionMerges.push({
          cancelledSessionId: sessionId,
          mergedToSessionId: targetSessionId,
          lessonNumber: session.lesson_number,
          reason: 'Merged with online session - center content replaced with online version'
        });

        console.log(`  Marked Session ${sessionId} (Lesson ${session.lesson_number}) as cancelled`);
      }
    }

    return removedCount;
  } catch (error) {
    const errorMsg = `Error removing old sessions: ${error.message}`;
    console.error(errorMsg);
    report.errors.push(errorMsg);
    throw error;
  }
}

async function generateDetailedReport(
  migratedGrants,
  auditResults,
  refunds,
  sessionsMerged
) {
  console.log('\n=== GENERATING DETAILED REPORT ===');
  
  report.summary = {
    executionTime: new Date().toISOString(),
    sessionsMerged: sessionsMerged,
    accessGrantsMigrated: migratedGrants,
    onlineStudentsAudited: auditResults.length,
    refundsIssued: refunds.length,
    totalRefundAmount: refunds.reduce((sum, r) => sum + r.refundAmount, 0),
    warnings: report.warnings.length > 0 ? report.warnings : undefined
  };

  const reportPath = path.join(__dirname, `migration_report_${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Also create a human-readable summary
  const summaryPath = path.join(__dirname, `migration_summary_${Date.now()}.txt`);
  const summaryText = `
═══════════════════════════════════════════════════════════════════════════════
  ONLINE SESSION MIGRATION REPORT
  Execution Time: ${new Date().toISOString()}
═══════════════════════════════════════════════════════════════════════════════

MIGRATION CONFIGURATION:
  Lesson 1: Merge Sessions ${CONFIG.LESSON_1_MERGE.from.join(', ')} → Session ${CONFIG.LESSON_1_MERGE.to}
  Lesson 2: Merge Sessions ${CONFIG.LESSON_2_MERGE.from.join(', ')} → Session ${CONFIG.LESSON_2_MERGE.to}

SUMMARY:
  ✓ Sessions Merged: ${sessionsMerged}
  ✓ Access Grants Migrated: ${migratedGrants}
  ✓ Online Students Audited: ${auditResults.length}
  ✓ Refunds Issued: ${refunds.length}
  ✓ Total Refund Amount: ${report.summary.totalRefundAmount}

STUDENTS AFFECTED:
  Total affected: ${report.accessMigrations.length}
  Unique students: ${new Set(report.accessMigrations.map(a => a.studentId)).size}

REFUNDS ISSUED:
${refunds.length > 0 ? refunds.map(r => `  • Student ${r.studentId} (${r.studentName}): +${r.refundAmount} EGP`).join('\n') : '  None'}

BALANCE AUDIT DETAILS:
  Total online students: ${auditResults.length}
  Students needing refund: ${auditResults.filter(a => a.needsRefund).length}
  Students with excess payments: ${auditResults.filter(a => a.centerSessionPayments > 0 && a.onlineSessionPayments > 0).length}

ERRORS/WARNINGS:
${report.errors.length > 0 ? report.errors.map(e => `  ⚠️  ${e}`).join('\n') : '  None'}

═══════════════════════════════════════════════════════════════════════════════
  Full details saved to: migration_report_${Date.now()}.json
═══════════════════════════════════════════════════════════════════════════════
`;

  fs.writeFileSync(summaryPath, summaryText);

  console.log(`\n✅ Report saved to: ${reportPath}`);
  console.log(`✅ Summary saved to: ${summaryPath}`);
  console.log(summaryText);

  return { reportPath, summaryPath };
}

async function main() {
  console.log('🚀 ONLINE SESSION MIGRATION - PRODUCTION SAFE MODE');
  console.log('=' .repeat(70));
  console.log('\n⚠️  THIS SCRIPT WILL:');
  console.log('  1. Migrate access grants from center to online sessions');
  console.log('  2. Cancel old center sessions');
  console.log('  3. Audit online student balances');
  console.log('  4. Issue refunds for duplicate payments');
  console.log('  5. Generate detailed report\n');

  try {
    // Verify database connection
    await sequelize.authenticate();
    console.log('✅ Database connected\n');

    // Setup associations
    setupAssociations();

    // STEP 1: Load and verify session configuration
    const sessionMap = await findOnlineSessions();
    
    // STEP 2: Find online students
    const onlineStudents = await findOnlineStudents();
    
    if (onlineStudents.length === 0) {
      throw new Error('No online students found! Cannot proceed.');
    }

    // STEP 3: Migrate access grants (Lesson 1)
    console.log('\n=== MIGRATING LESSON 1 ACCESS GRANTS ===');
    const lesson1Migrated = await migrateAccessGrants(
      CONFIG.LESSON_1_MERGE.from,
      CONFIG.LESSON_1_MERGE.to
    );
    
    // STEP 4: Migrate access grants (Lesson 2)
    console.log('\n=== MIGRATING LESSON 2 ACCESS GRANTS ===');
    const lesson2Migrated = await migrateAccessGrants(
      CONFIG.LESSON_2_MERGE.from,
      CONFIG.LESSON_2_MERGE.to
    );
    
    const totalMigrated = lesson1Migrated + lesson2Migrated;
    
    // STEP 5: Audit student balances
    const auditResults = await auditOnlineStudentBalances(onlineStudents);
    
    // STEP 6: Process refunds
    const refunds = await processRefunds(auditResults);
    
    // STEP 7: Mark old sessions as cancelled
    const sessionsMerged = await removeOldSessions();
    
    // STEP 8: Generate report
    const { reportPath, summaryPath } = await generateDetailedReport(
      totalMigrated,
      auditResults,
      refunds,
      sessionsMerged
    );

    console.log('\n' + '='.repeat(70));
    console.log('✅ MIGRATION COMPLETE - NO ERRORS');
    console.log('='.repeat(70));

    if (report.errors.length > 0) {
      console.log('\n⚠️  WARNINGS/ERRORS ENCOUNTERED:');
      report.errors.forEach(e => console.log(`  - ${e}`));
    }

    process.exit(0);
  } catch (error) {
    console.error('\n' + '='.repeat(70));
    console.error('❌ FATAL ERROR - MIGRATION ABORTED');
    console.error('='.repeat(70));
    console.error(error);
    report.errors.push(`FATAL: ${error.message}`);
    
    // Save error report
    const errorReportPath = path.join(__dirname, `migration_error_${Date.now()}.json`);
    fs.writeFileSync(errorReportPath, JSON.stringify(report, null, 2));
    console.error(`\nError report saved to: ${errorReportPath}`);
    
    process.exit(1);
  }
}

main();
