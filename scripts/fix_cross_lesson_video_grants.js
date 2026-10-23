// One-time repair for the "lesson 5 opens lesson 6 for free" bug (fixed in server.js, grantBelongsToStudentLesson).
// A video can be linked to sessions with different lesson numbers (e.g. Lecture 6 was also linked to a
// lesson-5 session). Opening it then copied the student's lesson-5 grant onto the video: no charge, no attendance.
//
// This finds every such copied grant (any video, any subject) and, for students who were never charged
// for and never attended their own lesson of that video, charges the normal online price, records the
// attendance on the student's own session, and turns the copied grant into a normal 'paid' grant.
//
//   node scripts/fix_cross_lesson_video_grants.js                       -> DRY RUN (reads only, changes nothing)
//   node scripts/fix_cross_lesson_video_grants.js --apply               -> applies, one transaction per student+lesson
//   node scripts/fix_cross_lesson_video_grants.js --apply --include-unwatched
//        also charges students who opened the video but have 0 watched seconds (skipped by default)
//   --video=66  limits the run to one video
//
// Safe to run more than once: a student+lesson already charged by this script (same reason text) is skipped.
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
const WatchProgress = require('../models/WatchProgress');
require('../models/associations')();
const { findSurchargeRule, surchargeReason } = require('../utils/onlineSessionSurcharge');

const APPLY = process.argv.includes('--apply');
const INCLUDE_UNWATCHED = process.argv.includes('--include-unwatched');
const ONLY_VIDEO = Number((process.argv.find(arg => arg.startsWith('--video=')) || '').split('=')[1]) || null;

// same values as server.js
const ONLINE_VIDEO_PAYMENT_REASON = 'دفع لمشاهدة حصة أونلاين';
const ATTENDANCE_COMMENT = '📹 حضر عن طريق دفع ثمن مشاهدة الفيديو أونلاين (تصحيح)';
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

const fixReason = (session, videoId) => `${ONLINE_VIDEO_PAYMENT_REASON} (سيريال ${session.serial_number}) - تصحيح فيديو #${videoId}`;

async function main() {
  console.log(APPLY ? '*** APPLY MODE ***' : '--- DRY RUN (nothing will be changed) ---');

  const videos = await Video.findAll({ where: ONLY_VIDEO ? { id: ONLY_VIDEO } : {}, attributes: ['id', 'title', 'SessionId'] });
  const links = await VideoSession.findAll({ where: { VideoId: videos.map(v => v.id) }, attributes: ['VideoId', 'SessionId'], order: [['id', 'ASC']] });
  const sessions = await Session.findAll({ attributes: ['id', 'SubjectId', 'CenterId', 'lesson_number', 'serial_number', 'video_price_center', 'video_price_online'] });
  const sessionById = new Map(sessions.map(s => [s.id, s]));
  const subjects = new Map((await Subject.findAll({ attributes: ['id', 'name'] })).map(s => [s.id, s.name]));
  const centers = new Map((await Center.findAll({ attributes: ['id', 'name'] })).map(c => [c.id, c.name]));
  const lessonSessionIds = (subjectId, lesson) => sessions.filter(s => s.SubjectId === subjectId && s.lesson_number === lesson).map(s => s.id);

  // linked sessions in the same order the server uses: main session first, then VideoSessions
  const linkedByVideo = new Map(videos.map(v => [v.id, [v.SessionId].filter(Boolean)]));
  links.forEach(l => { const list = linkedByVideo.get(l.VideoId); if (list && !list.includes(l.SessionId)) list.push(l.SessionId); });

  const grants = await VideoAccessGrant.findAll({ where: { VideoId: videos.map(v => v.id) } });
  const students = new Map((await Student.findAll({
    where: { id: [...new Set(grants.map(g => g.StudentId))] },
    attributes: ['id', 'name', 'student_code', 'SubjectId', 'CenterId', 'price_per_session', 'balance'],
  })).map(s => [s.id, s]));

  // group copied grants by student + own lesson (two videos of the same lesson are charged once)
  const groups = new Map();
  const skipped = [];
  for (const grant of grants) {
    const student = students.get(grant.StudentId);
    if (!student || student.student_code === 'STU-00000') continue;
    const linked = (linkedByVideo.get(grant.VideoId) || []).map(id => sessionById.get(id)).filter(Boolean);
    const direct = new Set(linked.map(s => s.id));
    const ownSession = linked.find(s => s.SubjectId === student.SubjectId && s.CenterId === student.CenterId);
    if (!ownSession) continue; // individual access from another group: not this bug
    const ownLesson = new Set(lessonSessionIds(ownSession.SubjectId, ownSession.lesson_number));
    // same rule as grantBelongsToStudentLesson in server.js (these grants are all for this video)
    if (ownLesson.has(grant.SessionId) || direct.has(grant.SessionId)) continue;

    const key = `${student.id}|${ownSession.SubjectId}|${ownSession.lesson_number}`;
    if (!groups.has(key)) groups.set(key, { student, ownSession, ownLesson: [...ownLesson], grants: [], videoIds: new Set() });
    groups.get(key).grants.push(grant);
    groups.get(key).videoIds.add(grant.VideoId);
  }

  const report = [];
  for (const group of groups.values()) {
    const { student, ownSession, ownLesson } = group;
    const videoIds = [...group.videoIds];
    const [attendance, charges, okGrant, watched] = await Promise.all([
      Attendance.findOne({ where: { StudentId: student.id, SessionId: ownLesson }, attributes: ['id'] }),
      BalanceTransaction.findAll({ where: { StudentId: student.id, SessionId: ownLesson, amount: { [Op.lt]: 0 } }, attributes: ['amount', 'reason'] }),
      VideoAccessGrant.findOne({ where: { StudentId: student.id, SessionId: ownLesson, method: { [Op.in]: ['paid', 'admin_paid', 'admin_free'] } }, attributes: ['id'] }),
      WatchProgress.sum('watched_seconds', {
        where: { StudentId: student.id, VideoPartId: (await VideoPart.findAll({ where: { VideoId: videoIds }, attributes: ['id'] })).map(p => p.id).concat([0]) },
      }),
    ]);
    const sourceMethods = [...new Set(group.grants.map(g => g.method))];
    const subjectName = subjects.get(ownSession.SubjectId);
    const studentIsOnline = isOnlineCenterName(centers.get(student.CenterId));
    const price = videoSessionPriceFor(student, ownSession, subjectName, studentIsOnline);
    const row = {
      studentId: student.id, code: student.student_code, name: student.name, center: centers.get(student.CenterId),
      subject: subjectName, lesson: ownSession.lesson_number, videos: videoIds.join(','), copiedFrom: sourceMethods.join(','),
      watchedMinutes: Math.round((Number(watched) || 0) / 60), price: price.total, balanceBefore: student.balance,
    };

    if (attendance || charges.length || okGrant) row.action = 'none: already attended/paid this lesson';
    else if (sourceMethods.every(m => m === 'admin_free' || m === 'admin_paid')) row.action = 'none: copied from an admin grant (review by hand)';
    else if (!row.watchedMinutes && !INCLUDE_UNWATCHED) row.action = 'none: opened but never watched (use --include-unwatched)';
    else row.action = 'CHARGE + ATTENDANCE';
    if (row.action !== 'CHARGE + ATTENDANCE') { skipped.push(row); continue; }

    row.balanceAfter = student.balance - price.total;
    if (APPLY) {
      await sequelize.transaction(async (transaction) => {
        const reason = fixReason(ownSession, videoIds[0]);
        const st = await Student.findByPk(student.id, { transaction, lock: transaction.LOCK.UPDATE });
        const already = await BalanceTransaction.findOne({ where: { StudentId: student.id, reason }, transaction });
        const attendedMeanwhile = await Attendance.findOne({ where: { StudentId: student.id, SessionId: ownLesson }, transaction });
        if (!st || already || attendedMeanwhile) { row.action = 'none: changed since dry run'; return; }
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
        // the copied grant becomes this lesson's normal paid grant (same access window)
        await VideoAccessGrant.update({ SessionId: ownSession.id, method: 'paid' }, { where: { id: group.grants.map(g => g.id) }, transaction });
        await st.reload({ attributes: ['balance'], transaction });
        row.balanceAfter = st.balance;
      });
    }
    report.push(row);
  }

  const byKey = rows => rows.reduce((acc, r) => { const k = `${r.subject} L${r.lesson} | ${r.center}`; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  console.log(`\n${APPLY ? 'Charged' : 'Would charge'} ${report.length} students (total ${report.reduce((s, r) => s + r.price, 0)} EGP); ${report.filter(r => r.balanceAfter < 0).length} would end below zero.`);
  console.table(byKey(report));
  console.log(`\nNot charged: ${skipped.length}`);
  console.table(skipped.reduce((acc, r) => { acc[r.action] = (acc[r.action] || 0) + 1; return acc; }, {}));

  const file = path.join(__dirname, '..', 'backups', `cross_lesson_video_fix_${APPLY ? 'applied' : 'preview'}_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ charged: report, skipped }, null, 2));
  console.log(`Full list saved to ${file}`);
}

main()
  .catch(err => { console.error('FAILED:', err); process.exitCode = 1; })
  .finally(() => sequelize.close());
