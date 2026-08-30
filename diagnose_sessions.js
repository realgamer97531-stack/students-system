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

async function runDiagnostics() {
  console.log('🔍 DIAGNOSTIC REPORT - ONLINE SESSION MIGRATION\n');
  
  try {
    await sequelize.authenticate();
    console.log('✅ Database connected\n');
    
    setupAssociations();

    // 1. Find all centers
    console.log('=== ALL CENTERS ===');
    const centers = await Center.findAll();
    centers.forEach(c => console.log(`  [${c.id}] ${c.name}`));

    // 2. Find all subjects
    console.log('\n=== ALL SUBJECTS ===');
    const subjects = await Subject.findAll();
    subjects.forEach(s => console.log(`  [${s.id}] ${s.name}`));

    // 3. Find sessions with "Lecture" or similar
    console.log('\n=== ALL SESSIONS (grouped by lesson number and serial) ===');
    const sessions = await Session.findAll({
      include: [
        { model: Center, attributes: ['id', 'name'] },
        { model: Subject, attributes: ['id', 'name'] },
        { model: Video, attributes: ['id', 'title'] }
      ],
      order: [['lesson_number', 'ASC'], ['serial_number', 'ASC']],
      raw: false
    });

    const grouped = {};
    sessions.forEach(s => {
      const key = `Lesson ${s.lesson_number} - Relative ${s.serial_number}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(s);
    });

    Object.entries(grouped).forEach(([key, seshes]) => {
      console.log(`\n  ${key}:`);
      seshes.forEach(s => {
        const videos = s.Videos.map(v => v.title).join(', ') || 'NO VIDEOS';
        console.log(`    [Session ID: ${s.id}] Center: ${s.Center?.name || 'N/A'}, Subject: ${s.Subject?.name || 'N/A'}`);
        console.log(`      Status: ${s.status}, Videos: ${videos}`);
      });
    });

    // 4. Count students by center
    console.log('\n=== STUDENTS BY CENTER ===');
    const students = await Student.findAll({
      include: [{ model: Center }],
      attributes: ['id', 'name', 'phone', 'CenterId'],
      raw: false
    });

    const studentsByCenter = {};
    students.forEach(s => {
      const centerName = s.Center?.name || 'NO CENTER';
      if (!studentsByCenter[centerName]) studentsByCenter[centerName] = [];
      studentsByCenter[centerName].push(s);
    });

    Object.entries(studentsByCenter).forEach(([center, stus]) => {
      console.log(`\n  ${center}: ${stus.length} students`);
      stus.slice(0, 3).forEach(s => console.log(`    - [${s.id}] ${s.name}`));
      if (stus.length > 3) console.log(`    ... and ${stus.length - 3} more`);
    });

    // 5. Check VideoAccessGrants - see which students have access to which sessions
    console.log('\n=== VIDEO ACCESS GRANTS SUMMARY ===');
    const grants = await VideoAccessGrant.findAll({
      include: [
        { model: Student, attributes: ['id', 'name'] },
        { model: Session, attributes: ['id', 'lesson_number', 'serial_number'] }
      ],
      raw: false
    });

    const grantsSummary = {};
    grants.forEach(g => {
      const key = `Session ${g.Session.id} (Lesson ${g.Session.lesson_number} Relative ${g.Session.serial_number})`;
      if (!grantsSummary[key]) grantsSummary[key] = [];
      grantsSummary[key].push({
        student: g.Student.name,
        method: g.method,
        views: g.max_views
      });
    });

    Object.entries(grantsSummary).forEach(([key, grants]) => {
      console.log(`\n  ${key}: ${grants.length} students`);
      grants.slice(0, 3).forEach(g => console.log(`    - ${g.student} (method: ${g.method}, views: ${g.views})`));
      if (grants.length > 3) console.log(`    ... and ${grants.length - 3} more`);
    });

    // 6. Check balance transactions
    console.log('\n=== BALANCE TRANSACTIONS SUMMARY ===');
    const transactions = await BalanceTransaction.findAll({
      include: [
        { model: Student, attributes: ['id', 'name'] },
        { model: Session, attributes: ['id', 'lesson_number', 'serial_number'] }
      ],
      raw: false
    });

    const transByStudent = {};
    transactions.forEach(t => {
      if (!transByStudent[t.StudentId]) {
        transByStudent[t.StudentId] = {
          name: t.Student.name,
          transactions: []
        };
      }
      transByStudent[t.StudentId].transactions.push({
        amount: t.amount,
        sessionId: t.SessionId,
        reason: t.reason,
        session: t.Session ? `Lesson ${t.Session.lesson_number} Relative ${t.Session.serial_number}` : 'N/A'
      });
    });

    console.log(`\nTotal students with transactions: ${Object.keys(transByStudent).length}`);
    Object.entries(transByStudent).slice(0, 5).forEach(([studentId, data]) => {
      console.log(`\n  [Student ${studentId}] ${data.name}:`);
      data.transactions.forEach(t => {
        console.log(`    - Amount: ${t.amount}, Session: ${t.session}, Reason: ${t.reason}`);
      });
    });

    // 7. Identify online students
    console.log('\n=== ONLINE STUDENTS IDENTIFIED ===');
    const onlineStudents = students.filter(s => 
      s.Center?.name?.toLowerCase().includes('online') || 
      s.Center?.name?.toLowerCase().includes('اونلاين')
    );
    console.log(`Found ${onlineStudents.length} online students`);
    onlineStudents.slice(0, 5).forEach(s => {
      console.log(`  - [${s.id}] ${s.name}`);
    });

    // Save diagnostic report
    const diagnosticReport = {
      timestamp: new Date().toISOString(),
      centers: centers.map(c => ({ id: c.id, name: c.name })),
      subjects: subjects.map(s => ({ id: s.id, name: s.name })),
      sessionGroups: Object.entries(grouped).map(([key, seshes]) => ({
        name: key,
        sessions: seshes.map(s => ({
          id: s.id,
          centerName: s.Center?.name,
          status: s.status,
          videoCount: s.Videos?.length || 0
        }))
      })),
      onlineStudentCount: onlineStudents.length,
      totalStudents: students.length,
      accessGrantsCount: grants.length,
      transactionsCount: transactions.length
    };

    const reportPath = path.join(__dirname, `diagnostic_report_${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(diagnosticReport, null, 2));
    console.log(`\n📄 Diagnostic report saved to: ${reportPath}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ ERROR:', error);
    process.exit(1);
  }
}

runDiagnostics();
