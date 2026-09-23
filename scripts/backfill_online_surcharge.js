// One-time catch-up for the online-session surcharge (see utils/onlineSessionSurcharge.js).
// Charges the extra amount to every student who ALREADY paid to watch the session online.
//
//   node scripts/backfill_online_surcharge.js            -> DRY RUN (reads only, changes nothing)
//   node scripts/backfill_online_surcharge.js --apply    -> applies, one transaction per student
//
// Safe to run more than once: a student who already has the surcharge transaction is skipped.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sequelize = require('../config/database');
const Student = require('../models/Student');
const Subject = require('../models/Subject');
const Session = require('../models/Session');
const Attendance = require('../models/Attendance');
const BalanceTransaction = require('../models/BalanceTransaction');
const VideoAccessGrant = require('../models/VideoAccessGrant');
require('../models/associations')();
const { ONLINE_SURCHARGE_RULES, surchargeReason } = require('../utils/onlineSessionSurcharge');

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(APPLY ? '*** APPLY MODE ***' : '--- DRY RUN (nothing will be changed) ---');
  const report = [];

  for (const rule of ONLINE_SURCHARGE_RULES) {
    const subject = await Subject.findOne({ where: { name: rule.subjectName } });
    if (!subject) { console.log(`Subject "${rule.subjectName}" not found - skipped`); continue; }

    const sessions = await Session.findAll({
      where: { SubjectId: subject.id, lesson_number: rule.lessonNumber },
      attributes: ['id'],
    });
    const sessionIds = sessions.map(s => s.id);
    if (!sessionIds.length) { console.log(`No sessions for ${rule.subjectName} lesson ${rule.lessonNumber}`); continue; }

    // Students who paid online for this lesson AND have an attendance record for it
    const grants = await VideoAccessGrant.findAll({
      where: { method: 'paid', SessionId: sessionIds },
      attributes: ['StudentId'],
    });
    const attendances = await Attendance.findAll({
      where: { SessionId: sessionIds },
      attributes: ['StudentId'],
    });
    const attendedIds = new Set(attendances.map(a => a.StudentId));
    const studentIds = [...new Set(grants.map(g => g.StudentId))].filter(id => attendedIds.has(id));

    const reason = surchargeReason(rule);
    const already = new Set((await BalanceTransaction.findAll({
      where: { StudentId: studentIds, reason },
      attributes: ['StudentId'],
    })).map(t => t.StudentId));

    const todo = studentIds.filter(id => !already.has(id));
    console.log(`${rule.subjectName} / lesson ${rule.lessonNumber}: ${studentIds.length} paid-online attendees, ${already.size} already charged, ${todo.length} to charge ${rule.extra} each`);

    for (const studentId of todo) {
      if (!APPLY) {
        const st = await Student.findByPk(studentId, { attributes: ['id', 'name', 'balance'] });
        report.push({ studentId, name: st?.name, before: st?.balance, after: st ? st.balance - rule.extra : null });
        continue;
      }
      await sequelize.transaction(async (transaction) => {
        const st = await Student.findByPk(studentId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!st) return;
        const dupe = await BalanceTransaction.findOne({ where: { StudentId: studentId, reason }, transaction });
        if (dupe) return;
        const before = st.balance;
        st.balance = before - rule.extra;
        await st.save({ transaction });
        await BalanceTransaction.create({
          StudentId: studentId,
          SessionId: sessionIds[0],
          amount: -rule.extra,
          reason,
        }, { transaction });
        report.push({ studentId, name: st.name, before, after: st.balance });
      });
    }
  }

  const negatives = report.filter(r => r.after !== null && r.after < 0).length;
  console.log(`\n${APPLY ? 'Charged' : 'Would charge'} ${report.length} students; ${negatives} would end with a negative balance.`);
  const file = path.join(__dirname, '..', 'backups', `online_surcharge_${APPLY ? 'applied' : 'preview'}_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`Report (before/after balances) saved to ${file}`);
}

main()
  .catch(err => { console.error('FAILED:', err); process.exitCode = 1; })
  .finally(() => sequelize.close());
