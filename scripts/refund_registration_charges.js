// Refunds new students who were charged at registration into an old / other-subject session
// (the selected session stayed on the staff login — fixed in commit ad76c43).
// Limited to the subjects and registration dates given; asked for on 2026-10-25: Senior 2 + Senior 3, registered from 2026-10-18.
// Per student: the attendance fee goes back to the balance (refund line in the history) and the wrong attendance is deleted.
//
//   node scripts/refund_registration_charges.js --from=2026-10-18 --subjects="Senior 2,Senior 3"           -> DRY RUN
//   node scripts/refund_registration_charges.js --from=2026-10-18 --subjects="Senior 2,Senior 3" --apply   -> applies
require('dotenv').config();
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '1';
const fs = require('fs');
const path = require('path');
const sequelize = require('../config/database');
const Student = require('../models/Student');
const Attendance = require('../models/Attendance');
const BalanceTransaction = require('../models/BalanceTransaction');
require('../models/associations')();

const arg = name => { const found = process.argv.find(a => a.startsWith(`--${name}=`)); return found ? found.slice(name.length + 3) : null; };
const APPLY = process.argv.includes('--apply');
const FROM = arg('from');
const SUBJECTS = (arg('subjects') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const REASON = 'استرجاع: اتخصم عند التسجيل في حصة مش بتاعته';

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM || '') || !SUBJECTS.length) throw new Error('Usage: --from=YYYY-MM-DD --subjects="Senior 2,Senior 3" [--apply]');
  console.log(APPLY ? '*** APPLY MODE ***' : '--- DRY RUN (nothing will be changed) ---');

  const rows = await sequelize.query(`
    SELECT st.id studentId, st.student_code code, st.name, sub.name subject, st.balance,
      DATE(CONVERT_TZ(st.createdAt, '+00:00', '+03:00')) registered,
      a.id attendanceId, s.session_date, s.lesson_number, ssub.name sessionSubject,
      (SELECT t.id FROM balancetransactions t WHERE t.StudentId = st.id AND t.reason = 'رسوم الحضور'
         AND t.createdAt BETWEEN st.createdAt AND st.createdAt + INTERVAL 2 MINUTE ORDER BY t.id LIMIT 1) chargeId
    FROM students st
    JOIN attendances a ON a.StudentId = st.id AND a.createdAt BETWEEN st.createdAt AND st.createdAt + INTERVAL 2 MINUTE
    JOIN sessions s ON s.id = a.SessionId
    JOIN subjects sub ON sub.id = st.SubjectId JOIN subjects ssub ON ssub.id = s.SubjectId
    WHERE (s.session_date <> DATE(CONVERT_TZ(st.createdAt, '+00:00', '+03:00')) OR s.SubjectId <> st.SubjectId)
      AND DATE(CONVERT_TZ(st.createdAt, '+00:00', '+03:00')) >= :from
    ORDER BY st.createdAt`, { replacements: { from: FROM }, type: sequelize.QueryTypes.SELECT });

  const picked = rows.filter(r => r.chargeId && SUBJECTS.some(s => r.subject.toLowerCase().includes(s)));
  const report = [];
  for (const row of picked) {
    const charge = await BalanceTransaction.findByPk(row.chargeId);
    const out = { ...row, refund: -charge.amount };
    if (APPLY) {
      await sequelize.transaction(async (transaction) => {
        if (await BalanceTransaction.findOne({ where: { StudentId: row.studentId, reason: REASON }, transaction })) { out.result = 'already refunded'; return; }
        await Student.increment({ balance: -charge.amount }, { where: { id: row.studentId }, transaction });
        await BalanceTransaction.create({ StudentId: row.studentId, SessionId: charge.SessionId, amount: -charge.amount, reason: REASON }, { transaction });
        out.attendanceRemoved = await Attendance.destroy({ where: { id: row.attendanceId, StudentId: row.studentId }, transaction });
        const st = await Student.findByPk(row.studentId, { attributes: ['balance'], transaction });
        out.balanceAfter = st.balance;
        out.result = 'refunded';
      });
    } else {
      out.balanceAfter = row.balance - charge.amount;
    }
    report.push(out);
  }

  console.log(`${APPLY ? 'Refunded' : 'Would refund'} ${report.length} students, ${report.reduce((s, r) => s + r.refund, 0)} EGP`);
  console.table(report.map(r => ({ code: r.code, name: r.name.slice(0, 24), subject: r.subject, registered: r.registered, refund: r.refund, before: r.balance, after: r.balanceAfter, result: r.result })));
  const file = path.join(__dirname, '..', 'backups', `registration_refund_${APPLY ? 'applied' : 'preview'}_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`List saved to ${file}`);
}

main()
  .catch(err => { console.error('FAILED:', err); process.exitCode = 1; })
  .finally(() => sequelize.close());
