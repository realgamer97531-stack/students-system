// نقل مادة من سنتر لسنتر تاني: الطلاب + الحصص (+ مواعيد الجدول لو اخترت) بتاعة (سنتر، مادة) بتتنقل للسنتر الجديد.
// - المعاينة مبتغيرش أي حاجة.
// - التنفيذ: نسخة احتياطية كاملة الأول (من server.js)، وبعدين كل التعديلات في transaction واحدة.
//   لو البيانات اتغيرت من وقت المعاينة (طالب اتضاف/حصة اتعملت) أو فيه حصة بنفس الرقم النسبي في السنتر الجديد → مفيش أي تعديل.
// - كل عملية نقل بتتسجل بالـ ids اللي اتنقلت بالظبط في جدول center_moves، وينفع ترجع (تراجع) لنفس الصفوف دي بس.
// - التحديث بـ Model.update فـ updatedAt بيتغير وأجهزة الديسكتوب بتاخد التعديل.
// الجدول بيتعمل بـ CREATE TABLE IF NOT EXISTS بس — مفيش أي تعديل على جداول موجودة.
const crypto = require('crypto');
const { DataTypes, Op } = require('sequelize');

let CenterMove = null;
let ensurePromise = null;

function defineModel(sequelize) {
  if (!CenterMove) {
    CenterMove = sequelize.define('CenterMove', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      from_center_id: { type: DataTypes.INTEGER, allowNull: false },
      to_center_id: { type: DataTypes.INTEGER, allowNull: false },
      subject_id: { type: DataTypes.INTEGER, allowNull: false },
      from_center_name: { type: DataTypes.STRING, allowNull: true },
      to_center_name: { type: DataTypes.STRING, allowNull: true },
      subject_name: { type: DataTypes.STRING, allowNull: true },
      student_ids: { type: DataTypes.TEXT('long'), allowNull: false },
      session_ids: { type: DataTypes.TEXT('long'), allowNull: false },
      schedule_ids: { type: DataTypes.TEXT('long'), allowNull: false },
      user_id: { type: DataTypes.INTEGER, allowNull: true },
      user_name: { type: DataTypes.STRING, allowNull: true },
      undone_at: { type: DataTypes.DATE, allowNull: true },
      undone_by: { type: DataTypes.STRING, allowNull: true },
    }, { tableName: 'center_moves' });
  }
  return CenterMove;
}

function ensureCenterMoveSchema(sequelize) {
  defineModel(sequelize);
  if (!ensurePromise) {
    ensurePromise = CenterMove.sync().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

function toId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function fingerprintOf(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

// كل اللي هيحصل لو نفذنا — من غير أي تعديل
async function buildPreview(models, { fromCenterId, toCenterId, subjectId, moveSchedule }, transaction) {
  const { Center, Subject, Student, Session, ScheduleEntry } = models;
  const from = toId(fromCenterId);
  const to = toId(toCenterId);
  const subj = toId(subjectId);
  if (!from || !to || !subj) return { error: 'اختار السنتر القديم والمادة والسنتر الجديد' };
  if (from === to) return { error: 'السنتر القديم والجديد نفس السنتر' };

  const lock = transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};
  const [fromCenter, toCenter, subject] = await Promise.all([
    Center.findByPk(from, { attributes: ['id', 'name'], transaction }),
    Center.findByPk(to, { attributes: ['id', 'name'], transaction }),
    Subject.findByPk(subj, { attributes: ['id', 'name'], transaction }),
  ]);
  if (!fromCenter || !toCenter || !subject) return { error: 'السنتر أو المادة غير موجودة' };

  const students = await Student.findAll({
    where: { CenterId: from, SubjectId: subj },
    attributes: ['id', 'student_code', 'name'],
    order: [['id', 'ASC']],
    ...lock,
  });
  const sessions = await Session.findAll({
    where: { CenterId: from, SubjectId: subj },
    attributes: ['id', 'lesson_number', 'serial_number', 'session_date', 'status'],
    order: [['lesson_number', 'ASC'], ['id', 'ASC']],
    ...lock,
  });
  const targetSessions = await Session.findAll({
    where: { CenterId: to, SubjectId: subj },
    attributes: ['id', 'lesson_number', 'serial_number', 'session_date', 'status'],
    order: [['lesson_number', 'ASC'], ['id', 'ASC']],
    ...lock,
  });
  const scheduleEntries = await ScheduleEntry.findAll({
    where: { CenterId: from, SubjectId: subj },
    order: [['day_of_week', 'ASC'], ['start_time', 'ASC']],
    ...lock,
  });
  const targetScheduleEntries = await ScheduleEntry.findAll({
    where: { CenterId: to, SubjectId: subj },
    order: [['day_of_week', 'ASC'], ['start_time', 'ASC']],
    transaction,
  });
  const targetStudentsCount = await Student.count({ where: { CenterId: to, SubjectId: subj }, transaction });

  // نفس الرقم النسبي موجود في السنتر الجديد = حصتين بنفس الرقم في نفس السنتر والمادة → ممنوع
  const targetByLesson = new Map(targetSessions.map(s => [s.lesson_number, s]));
  const conflicts = sessions
    .filter(s => targetByLesson.has(s.lesson_number))
    .map(s => ({ moving: s, existing: targetByLesson.get(s.lesson_number) }));

  const maxLesson = list => list.reduce((m, s) => Math.max(m, Number(s.lesson_number) || 0), 0);
  const nextBefore = maxLesson(targetSessions) + 1;
  const nextAfter = Math.max(maxLesson(targetSessions), maxLesson(sessions)) + 1;

  const willMoveSchedule = !!moveSchedule && scheduleEntries.length > 0;
  const ids = {
    students: students.map(s => s.id),
    sessions: sessions.map(s => s.id),
    schedule: willMoveSchedule ? scheduleEntries.map(e => e.id) : [],
  };
  const fingerprint = fingerprintOf({ from, to, subj, ids, target: targetSessions.map(s => [s.id, s.lesson_number]) });

  return {
    from: fromCenter, to: toCenter, subject,
    students, sessions, targetSessions, scheduleEntries, targetScheduleEntries, targetStudentsCount,
    conflicts, nextBefore, nextAfter, willMoveSchedule, moveSchedule: !!moveSchedule,
    ids, fingerprint,
    nothingToMove: students.length === 0 && sessions.length === 0 && ids.schedule.length === 0,
  };
}

// التنفيذ الفعلي. لازم fingerprint المعاينة يطابق اللي في القاعدة دلوقتي
async function executeMove(sequelize, models, params, { fingerprint, user }) {
  await ensureCenterMoveSchema(sequelize);
  const { Student, Session, ScheduleEntry } = models;

  return sequelize.transaction(async (transaction) => {
    const preview = await buildPreview(models, params, transaction);
    if (preview.error) return { error: preview.error };
    if (preview.fingerprint !== fingerprint) {
      return { error: 'البيانات اتغيرت من وقت المعاينة (طالب أو حصة اتضافت/اتنقلت). اعمل معاينة تاني وراجعها قبل التنفيذ.' };
    }
    if (preview.conflicts.length) return { error: 'فيه حصص بنفس الرقم النسبي في السنتر الجديد — اتلغى النقل.' };
    if (preview.nothingToMove) return { error: 'مفيش حاجة تتنقل' };

    const from = preview.from.id;
    const to = preview.to.id;
    const subj = preview.subject.id;
    const { ids } = preview;

    const check = (label, expected, [affected]) => {
      if (affected !== expected) throw new Error(`عدد ${label} اللي اتنقل (${affected}) مش زي المتوقع (${expected}) — اتلغى كل حاجة`);
    };

    if (ids.students.length) {
      check('الطلاب', ids.students.length, await Student.update(
        { CenterId: to },
        { where: { id: ids.students, CenterId: from, SubjectId: subj }, transaction },
      ));
    }
    if (ids.sessions.length) {
      check('الحصص', ids.sessions.length, await Session.update(
        { CenterId: to },
        { where: { id: ids.sessions, CenterId: from, SubjectId: subj }, transaction },
      ));
    }
    if (ids.schedule.length) {
      check('مواعيد الجدول', ids.schedule.length, await ScheduleEntry.update(
        { CenterId: to },
        { where: { id: ids.schedule, CenterId: from, SubjectId: subj }, transaction },
      ));
    }

    const move = await CenterMove.create({
      from_center_id: from,
      to_center_id: to,
      subject_id: subj,
      from_center_name: preview.from.name,
      to_center_name: preview.to.name,
      subject_name: preview.subject.name,
      student_ids: JSON.stringify(ids.students),
      session_ids: JSON.stringify(ids.sessions),
      schedule_ids: JSON.stringify(ids.schedule),
      user_id: user && user.id ? user.id : null,
      user_name: user && user.name ? user.name : null,
    }, { transaction });

    return { move, counts: { students: ids.students.length, sessions: ids.sessions.length, schedule: ids.schedule.length } };
  });
}

function parseIds(text) {
  try {
    const list = JSON.parse(text || '[]');
    return Array.isArray(list) ? list.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  } catch (e) {
    return [];
  }
}

// التراجع: نفس الصفوف بالظبط ترجع للسنتر القديم (بس اللي لسه في السنتر الجديد ونفس المادة)
async function undoMove(sequelize, models, moveId, { user }) {
  await ensureCenterMoveSchema(sequelize);
  const { Student, Session, ScheduleEntry } = models;

  return sequelize.transaction(async (transaction) => {
    const move = await CenterMove.findByPk(moveId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!move) return { error: 'عملية النقل غير موجودة' };
    if (move.undone_at) return { error: 'العملية دي اتعمل لها تراجع قبل كده' };

    const from = move.from_center_id;
    const to = move.to_center_id;
    const subj = move.subject_id;
    const sessionIds = parseIds(move.session_ids);

    // لو اتعملت حصة جديدة في السنتر القديم بنفس رقم حصة راجعة → ممنوع
    if (sessionIds.length) {
      const returning = await Session.findAll({ where: { id: sessionIds, CenterId: to, SubjectId: subj }, attributes: ['lesson_number'], transaction });
      const lessons = [...new Set(returning.map(s => s.lesson_number))];
      if (lessons.length) {
        const clash = await Session.findOne({ where: { CenterId: from, SubjectId: subj, lesson_number: { [Op.in]: lessons } }, attributes: ['lesson_number', 'serial_number'], transaction });
        if (clash) return { error: `مينفعش التراجع: فيه حصة ${clash.lesson_number} اتعملت في السنتر القديم بعد النقل (سيريال ${clash.serial_number})` };
      }
    }

    const [students] = await Student.update({ CenterId: from }, { where: { id: parseIds(move.student_ids), CenterId: to, SubjectId: subj }, transaction });
    const [sessions] = await Session.update({ CenterId: from }, { where: { id: sessionIds, CenterId: to, SubjectId: subj }, transaction });
    const scheduleIds = parseIds(move.schedule_ids);
    const [schedule] = scheduleIds.length
      ? await ScheduleEntry.update({ CenterId: from }, { where: { id: scheduleIds, CenterId: to, SubjectId: subj }, transaction })
      : [0];

    await move.update({ undone_at: new Date(), undone_by: user && user.name ? user.name : null }, { transaction });
    return { move, counts: { students, sessions, schedule } };
  });
}

async function listMoves(sequelize, limit = 20) {
  try {
    await ensureCenterMoveSchema(sequelize);
    return await CenterMove.findAll({ order: [['id', 'DESC']], limit });
  } catch (error) {
    console.error('Failed to list center moves:', error.message);
    return [];
  }
}

module.exports = { buildPreview, executeMove, undoMove, listMoves, ensureCenterMoveSchema, parseIds };
