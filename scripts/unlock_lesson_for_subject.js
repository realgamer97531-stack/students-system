// Opens one lesson's video for EVERY student of a subject, charges whoever hasn't paid for that lesson yet
// (balance may go below zero), records their attendance, and gives everyone access until N days from now.
// Asked for on 2026-10-23 for Math Senior 1, lesson 6 (video 66).
//
//   node scripts/unlock_lesson_for_subject.js --subject="Math Senior 1" --lesson=6 --video=66 --days=7            -> DRY RUN
//   node scripts/unlock_lesson_for_subject.js --subject="Math Senior 1" --lesson=6 --video=66 --days=7 --apply    -> applies
//
// Not charged again: anyone with a charge on this lesson (any center) or an admin grant for it.
// Skipped: blocked students, students removed from this video, the all-access account, and centers
// with no session of this lesson linked to the video.
// Safe to run more than once: the charge has a fixed reason text, and access is set to "N days from
// now" (an access that already ends later is kept as it is).
require('dotenv').config();
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '1';
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const Student = require('../models/Student');
const Subject = require('../models/Subject');
const Center = require('../models/Center');
const Session = require('../models/Session');
const Attendance = require('../models/Attendance');
const BalanceTransaction = require('../models/BalanceTransaction');
const VideoAccessGrant = require('../models/VideoAccessGrant');
const Video = require('../models/Video');
const VideoPart = require('../models/VideoPart');
const VideoSession = require('../models/VideoSession');
const VideoStudentBlock = require('../models/VideoStudentBlock');
require('../models/associations')();
const { findSurchargeRule, surchargeReason } = require('../utils/onlineSessionSurcharge');

const arg = name => { const found = process.argv.find(a => a.startsWith(`--${name}=`)); return found ? found.slice(name.length + 3) : null; };
const APPLY = process.argv.includes('--apply');
const SUBJECT = arg('subject');
const LESSON = Number(arg('lesson'));
const VIDEO_ID = Number(arg('video'));
const DAYS = Number(arg('days')) || 7;
if (!SUBJECT || !LESSON || !VIDEO_ID) { console.error('Usage: --subject="Math Senior 1" --lesson=6 --video=66 [--days=7] [--apply]'); process.exit(1); }

// same values as server.js
const ONLINE_VIDEO_PAYMENT_REASON = 'دفع لمشاهدة حصة أونلاين';
const ATTENDANCE_COMMENT = '📹 الحصة اتفتحت لكل الطلاب واتخصمت من الرصيد';
const isOnlineCenterName = name => ['أونلاين', 'اونلاين', 'online', 'on-line', 'online center'].includes(String(name || '').trim().toLowerCase());
const normalSessionPriceForSubject = name => (/senior\s*1/i.test(String(name || '')) ? 80 : 90);

function videoSessionPriceFor(student, session, subjectName, studentIsOnline) {
  const customPrice = studentIsOnline ? session.video_price_online : session.video_price_center;
  if (customPrice !== null && customPrice !== undefined && customPrice !== '') {
    const ratio = Math.max(0, Number(customPrice) || 0) / normalSessionPriceForSubject(subjectName);
    const total = Math.round((Number(student.price_per_session) || 0) * ratio);
    return { total, base: total, surcharge: 0, rule: null };
  }
  const base = Number(student.price_per_session) || 0;
  const rule = findSurchargeRule(subjectName, session.lesson_number);
  const surcharge = rule ? rule.extra : 0;
  return { total: base + surcharge, base, surcharge, rule };
}

async function main() {
  console.log(APPLY ? '*** APPLY MODE ***' : '--- DRY RUN (nothing will be changed) ---');
  const HOUR = 60 * 60 * 1000;
  const now = new Date();
  const target = new Date(now.getTime() + DAYS * 24 * HOUR);

  const subject = await Subject.findOne({ where: { name: SUBJECT } });
  const video = await Video.findByPk(VIDEO_ID, { attributes: ['id', 'title', 'SessionId', 'createdAt'] });
  if (!subject || !video) throw new Error('Subject or video not found');
  console.log(`${SUBJECT} / lesson ${LESSON} / video #${video.id} "${video.title}" -> access until ${target.toISOString()}`);

  const lessonSessions = await Session.findAll({ where: { SubjectId: subject.id, lesson_number: LESSON } });
  const lessonIds = lessonSessions.map(s => s.id);
  const linkedIds = new Set([video.SessionId, ...(await VideoSession.findAll({ where: { VideoId: video.id }, attributes: ['SessionId'] })).map(r => r.SessionId)].filter(Boolean));
  const sessionByCenter = new Map(lessonSessions.filter(s => linkedIds.has(s.id)).map(s => [s.CenterId, s]));
  const centers = new Map((await Center.findAll({ attributes: ['id', 'name'] })).map(c => [c.id, c.name]));
  const blocked = new Set((await VideoStudentBlock.findAll({ where: { VideoId: video.id }, attributes: ['StudentId'] })).map(b => b.StudentId));
  const firstPart = await VideoPart.min('createdAt', { where: { VideoId: video.id } });
  const firstPartAt = firstPart ? new Date(firstPart) : null;

  const students = await Student.findAll({ where: { SubjectId: subject.id }, order: [['id', 'ASC']] });
  const charged = [], extended = [], skipped = [];
  for (const student of students) {
    const base = { studentId: student.id, code: student.student_code, name: student.name, center: centers.get(student.CenterId) };
    const ownSession = sessionByCenter.get(student.CenterId);
    if (student.student_code === 'STU-00000') { skipped.push({ ...base, why: 'all-access account' }); continue; }
    if (student.is_blocked) { skipped.push({ ...base, why: 'student is blocked' }); continue; }
    if (blocked.has(student.id)) { skipped.push({ ...base, why: 'removed from this video' }); continue; }
    if (!ownSession) { skipped.push({ ...base, why: 'center has no lesson session on this video' }); continue; }

    const price = videoSessionPriceFor(student, ownSession, subject.name, isOnlineCenterName(centers.get(student.CenterId)));
    const reason = `${ONLINE_VIDEO_PAYMENT_REASON} (سيريال ${ownSession.serial_number}) - فتح الحصة للكل`;

    const work = async (transaction) => {
      const st = await Student.findByPk(student.id, { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
      const [lessonCharge, adminGrant, grants] = await Promise.all([
        BalanceTransaction.findOne({ where: { StudentId: st.id, SessionId: lessonIds, amount: { [Op.lt]: 0 } }, transaction }),
        VideoAccessGrant.findOne({ where: { StudentId: st.id, SessionId: lessonIds, method: { [Op.in]: ['admin_free', 'admin_paid'] } }, transaction }),
        VideoAccessGrant.findAll({ where: { StudentId: st.id, SessionId: lessonIds, VideoId: video.id }, order: [['id', 'ASC']], transaction }),
      ]);
      const mustPay = !lessonCharge && !adminGrant;
      const row = { ...base, balanceBefore: st.balance };

      if (mustPay) {
        row.price = price.total;
        row.balanceAfter = st.balance - price.total;
        if (transaction) {
          await Student.increment({ balance: -price.total }, { where: { id: st.id }, transaction });
          await BalanceTransaction.create({ StudentId: st.id, SessionId: ownSession.id, amount: -price.base, reason }, { transaction });
          if (price.surcharge > 0) {
            await BalanceTransaction.create({ StudentId: st.id, SessionId: ownSession.id, amount: -price.surcharge, reason: surchargeReason(price.rule) }, { transaction });
          }
          await Attendance.findOrCreate({
            where: { StudentId: st.id, SessionId: ownSession.id },
            defaults: { StudentId: st.id, SessionId: ownSession.id, comment: ATTENDANCE_COMMENT },
            transaction,
          });
        }
      }

      // access: the grant for this video gets "until N days from now" (kept if it already ends later)
      const grant = grants.find(g => g.method !== 'attended') || grants[0] || null;
      const currentEnd = grant && grant.access_expires_at ? new Date(grant.access_expires_at) : null;
      const startedAt = grant && grant.access_started_at && (!firstPartAt || new Date(grant.access_started_at) >= firstPartAt)
        ? new Date(grant.access_started_at) : now;
      const end = currentEnd && currentEnd > target ? currentEnd : target;
      row.accessUntil = end.toISOString();
      if (transaction) {
        const fields = {
          access_started_at: startedAt,
          access_expires_at: end,
          access_duration_hours: Math.max(1, Math.ceil((end - startedAt) / HOUR)),
        };
        if (grant) {
          await VideoAccessGrant.update({ ...fields, ...(mustPay ? { method: 'paid' } : {}) }, { where: { id: grant.id }, transaction });
        } else {
          await VideoAccessGrant.create({
            StudentId: st.id, SessionId: ownSession.id, VideoId: video.id,
            method: mustPay || !adminGrant ? 'paid' : adminGrant.method, max_views: 999, views_used: 0, ...fields,
          }, { transaction });
        }
        await st.reload({ attributes: ['balance'], transaction });
        if (mustPay) row.balanceAfter = st.balance;
      }
      (mustPay ? charged : extended).push(row);
    };

    // a re-run never charges twice: the lesson charge from the first run is found above
    if (APPLY) await sequelize.transaction(work);
    else await work(null);
  }

  console.log(`\n${APPLY ? 'Charged' : 'Would charge'} ${charged.length} students (total ${charged.reduce((s, r) => s + r.price, 0)} EGP); ${charged.filter(r => r.balanceAfter < 0).length} end below zero.`);
  console.log(`Already paid / admin access, access extended only: ${extended.length}`);
  console.log(`Skipped: ${skipped.length}`);
  console.table(skipped.reduce((acc, r) => { acc[r.why] = (acc[r.why] || 0) + 1; return acc; }, {}));
  console.table(charged.reduce((acc, r) => { acc[r.center] = (acc[r.center] || 0) + 1; return acc; }, {}));

  const file = path.join(__dirname, '..', 'backups', `unlock_lesson_${APPLY ? 'applied' : 'preview'}_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ subject: SUBJECT, lesson: LESSON, videoId: video.id, accessUntil: target, charged, extended, skipped }, null, 2));
  console.log(`Full list saved to ${file}`);
}

main()
  .catch(err => { console.error('FAILED:', err); process.exitCode = 1; })
  .finally(() => sequelize.close());
