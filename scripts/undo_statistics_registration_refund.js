// Undoes scripts/refund_registration_charges.js for the Statistics Senior 3 students (2026-10-25: the user
// wanted them left charged). Per student: the refund line is deleted, the 90 goes back off the balance, and the
// deleted attendance is put back with its original id (session, staff user, time = registration + 2s, no comment,
// payment_collected = the money paid at registration).
//
//   node scripts/undo_statistics_registration_refund.js            -> DRY RUN
//   node scripts/undo_statistics_registration_refund.js --apply    -> applies
require('dotenv').config();
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '1';
const fs = require('fs');
const path = require('path');
const sequelize = require('../config/database');

const APPLY = process.argv.includes('--apply');
const REASON = 'استرجاع: اتخصم عند التسجيل في حصة مش بتاعته';
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: sequelize.QueryTypes.SELECT });

async function sessionIdFor(row) {
  const [session] = await q(`SELECT s.id FROM sessions s JOIN subjects sub ON sub.id = s.SubjectId JOIN centers c ON c.id = s.CenterId
    WHERE sub.name = :subject AND s.lesson_number = :lesson AND s.session_date = :date AND c.name = :center`,
  { subject: row.sessionSubject, lesson: row.lesson_number, date: row.session_date, center: row.sessionCenter });
  return session ? session.id : null;
}

async function main() {
  console.log(APPLY ? '*** APPLY MODE ***' : '--- DRY RUN (nothing will be changed) ---');
  const file = fs.readdirSync(path.join(__dirname, '..', 'backups')).filter(n => n.startsWith('registration_refund_applied')).sort().pop();
  const refunded = require(path.join(__dirname, '..', 'backups', file)).filter(r => /statistics/i.test(r.subject));

  // which center each wrong session was in (from the list shown to the user)
  const centerBySession = { 'Statistics Senior 3|1|2026-10-04': 'الرياض ميامي', 'Math Senior 3|15|2026-10-18': 'الرياض ميامي', 'Math Senior 1|6|2026-10-15': 'Online' };
  const report = [];
  for (const r of refunded) {
    const row = { ...r, sessionCenter: centerBySession[`${r.sessionSubject}|${r.lesson_number}|${r.session_date}`] };
    const sessionId = await sessionIdFor(row);
    const [student] = await q(`SELECT st.id, st.balance, st.UserId, st.createdAt,
        (SELECT COALESCE(SUM(t.amount), 0) FROM balancetransactions t WHERE t.StudentId = st.id AND t.reason NOT LIKE 'نقاط:%'
           AND t.reason NOT LIKE 'دفع بوكليت%' AND t.reason <> 'رسوم الحضور' AND t.reason <> :reason) money
      FROM students st WHERE st.id = :id`, { id: r.studentId, reason: REASON });
    const [refund] = await q(`SELECT id, amount FROM balancetransactions WHERE StudentId = :id AND reason = :reason`, { id: r.studentId, reason: REASON });
    // registration put the paid money in the balance and took 90 for the session; the refund gave the 90 back,
    // so paid at registration = today's balance minus any other money movement since (booklet payments don't touch the balance)
    const paidAtRegistration = Number(student.balance) - Number(student.money);
    const out = { code: r.code, name: r.name, sessionId, attendanceId: r.attendanceId, refund: refund && refund.amount, paidAtRegistration, balanceBefore: student.balance, balanceAfter: student.balance - (refund ? refund.amount : 0) };
    if (!sessionId || !refund) { out.result = 'SKIPPED: ' + (!sessionId ? 'session not found' : 'no refund line'); report.push(out); continue; }

    if (APPLY) {
      await sequelize.transaction(async (transaction) => {
        const [exists] = await q('SELECT id FROM attendances WHERE id = :id OR (StudentId = :sid AND SessionId = :session)', { id: r.attendanceId, sid: r.studentId, session: sessionId }, transaction);
        if (exists) { out.result = 'attendance already there'; return; }
        await sequelize.query('DELETE FROM balancetransactions WHERE id = :id AND reason = :reason', { replacements: { id: refund.id, reason: REASON }, transaction });
        await sequelize.query('UPDATE students SET balance = balance - :amount, updatedAt = NOW() WHERE id = :id', { replacements: { amount: refund.amount, id: r.studentId }, transaction });
        // the time is computed inside the DB (UTC): a JS Date here would be written in Cairo time, 3h late
        await sequelize.query(`INSERT INTO attendances (id, attended_at, comment, payment_collected, createdAt, updatedAt, StudentId, SessionId, UserId)
          SELECT :id, st.createdAt + INTERVAL 2 SECOND, NULL, :paid, st.createdAt + INTERVAL 2 SECOND, NOW(), st.id, :session, st.UserId
          FROM students st WHERE st.id = :sid`,
        { replacements: { id: r.attendanceId, paid: paidAtRegistration, sid: r.studentId, session: sessionId }, transaction });
        const [after] = await q('SELECT balance FROM students WHERE id = :id', { id: r.studentId }, transaction);
        out.balanceAfter = after.balance;
        out.result = 'restored';
      });
    }
    report.push(out);
  }

  console.log(`${APPLY ? 'Restored' : 'Would restore'} ${report.filter(r => !String(r.result || '').startsWith('SKIPPED')).length} of ${report.length}`);
  console.table(report.map(r => ({ code: r.code, name: String(r.name).slice(0, 22), session: r.sessionId, attendance: r.attendanceId, paidAtReg: r.paidAtRegistration, before: r.balanceBefore, after: r.balanceAfter, result: r.result })));
  fs.writeFileSync(path.join(__dirname, '..', 'backups', `undo_statistics_refund_${APPLY ? 'applied' : 'preview'}_${Date.now()}.json`), JSON.stringify(report, null, 2));
}

main()
  .catch(err => { console.error('FAILED:', err); process.exitCode = 1; })
  .finally(() => sequelize.close());
