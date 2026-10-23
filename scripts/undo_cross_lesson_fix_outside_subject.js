// Undoes what scripts/fix_cross_lesson_video_grants.js did on 2026-10-23 for students OUTSIDE one subject
// (it was meant for Math Senior 1 only). For each of its charges: the charge is deleted and the money goes
// back to the balance, and the attendance + video access it added are removed.
//
//   node scripts/undo_cross_lesson_fix_outside_subject.js --keep="Math Senior 1"           -> DRY RUN
//   node scripts/undo_cross_lesson_fix_outside_subject.js --keep="Math Senior 1" --apply   -> applies
require('dotenv').config();
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '1';
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const Student = require('../models/Student');
const Subject = require('../models/Subject');
const Attendance = require('../models/Attendance');
const BalanceTransaction = require('../models/BalanceTransaction');
const VideoAccessGrant = require('../models/VideoAccessGrant');
require('../models/associations')();

const APPLY = process.argv.includes('--apply');
const KEEP = (process.argv.find(a => a.startsWith('--keep=')) || '').slice('--keep='.length);
const ATTENDANCE_COMMENT = '📹 حضر عن طريق دفع ثمن مشاهدة الفيديو أونلاين (تصحيح)';

async function main() {
  if (!KEEP) throw new Error('Pass --keep="<subject that stays charged>"');
  console.log(APPLY ? '*** APPLY MODE ***' : '--- DRY RUN (nothing will be changed) ---');
  const keep = await Subject.findOne({ where: { name: KEEP } });
  if (!keep) throw new Error(`Subject "${KEEP}" not found`);

  const charges = await BalanceTransaction.findAll({
    where: { reason: { [Op.like]: '%تصحيح فيديو #%' }, createdAt: { [Op.gte]: new Date('2026-10-23T00:00:00Z') } },
    include: [{ model: Student, attributes: ['id', 'name', 'student_code', 'SubjectId', 'balance'], where: { SubjectId: { [Op.ne]: keep.id } } }],
  });

  const report = [];
  for (const charge of charges) {
    const videoId = Number((charge.reason.match(/تصحيح فيديو #(\d+)/) || [])[1]);
    const row = { studentId: charge.StudentId, code: charge.Student.student_code, name: charge.Student.name, refund: -charge.amount, videoId, balanceBefore: charge.Student.balance };
    if (APPLY) {
      await sequelize.transaction(async (transaction) => {
        const still = await BalanceTransaction.findByPk(charge.id, { transaction });
        if (!still) { row.result = 'already undone'; return; }
        await Student.increment({ balance: -still.amount }, { where: { id: still.StudentId }, transaction });
        await still.destroy({ transaction });
        row.attendanceRemoved = await Attendance.destroy({ where: { StudentId: still.StudentId, SessionId: still.SessionId, comment: ATTENDANCE_COMMENT }, transaction });
        row.grantsRemoved = await VideoAccessGrant.destroy({ where: { StudentId: still.StudentId, SessionId: still.SessionId, VideoId: videoId, method: 'paid' }, transaction });
        const st = await Student.findByPk(still.StudentId, { attributes: ['balance'], transaction });
        row.balanceAfter = st.balance;
        row.result = 'undone';
      });
    } else {
      row.balanceAfter = charge.Student.balance - charge.amount;
    }
    report.push(row);
  }

  console.log(`${APPLY ? 'Undone' : 'Would undo'} ${report.length} charges, refunding ${report.reduce((s, r) => s + r.refund, 0)} EGP`);
  const file = path.join(__dirname, '..', 'backups', `undo_cross_lesson_fix_${APPLY ? 'applied' : 'preview'}_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`List saved to ${file}`);
}

main()
  .catch(err => { console.error('FAILED:', err); process.exitCode = 1; })
  .finally(() => sequelize.close());
