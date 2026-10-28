// نقل درجات الواجب و/أو الامتحانات من حصة لحصة تانية (من الإعدادات)
//   الواجب: صفوف HomeworkCheck (طالب + حصة) بتتنقل للحصة الجديدة. لو الطالب عنده واجب متسجل بالفعل في الحصة
//           الجديدة، بنسيب الاتنين زي ما هما (مبنمسحش درجة حد) وبنعرضهم في المعاينة.
//   الامتحان: كل امتحان مربوط بالحصة القديمة بيتربط بالجديدة، ودرجات الطلاب بتمشي معاه.
// النقاط مش بتتغير: نقاط الواجب اتحسبت وقت التسجيل ومش مربوطة برقم الحصة.
const { Op } = require('sequelize');

const KINDS = ['homework', 'exam', 'both'];
const STATUS_LABELS = { complete: 'كامل', incomplete: 'مش كامل', no_steps: 'من غير خطوات', not_done: 'مش محلول' };

function describe(session) {
  return `حصة ${session.lesson_number} - ${session.Subject ? session.Subject.name : ''} - ${session.Center ? session.Center.name : ''} (سيريال ${session.serial_number}${session.session_date ? `، ${session.session_date}` : ''})`;
}

async function loadPair(models, fromId, toId, transaction) {
  const { Session, Center, Subject } = models;
  const include = [{ model: Center, attributes: ['id', 'name'] }, { model: Subject, attributes: ['id', 'name'] }];
  const [from, to] = await Promise.all([
    Session.findByPk(fromId, { include, transaction }),
    Session.findByPk(toId, { include, transaction }),
  ]);
  if (!from || !to) return { error: 'اختار الحصة القديمة والحصة الجديدة' };
  if (from.id === to.id) return { error: 'الحصة القديمة والجديدة نفس الحصة' };
  if (Number(from.SubjectId) !== Number(to.SubjectId)) return { error: 'الحصتين لازم يكونوا من نفس المادة' };
  return { from, to };
}

async function buildPreview(models, { fromId, toId, kind }, transaction) {
  if (!KINDS.includes(kind)) return { error: 'اختار نقل الواجب أو الامتحان' };
  const pair = await loadPair(models, fromId, toId, transaction);
  if (pair.error) return pair;
  const { from, to } = pair;
  const { HomeworkCheck, Exam, ExamResult, Attendance, Student } = models;
  const out = { kind, from: { id: from.id, label: describe(from) }, to: { id: to.id, label: describe(to) } };

  if (kind !== 'exam') {
    const [source, target, attended] = await Promise.all([
      HomeworkCheck.findAll({ where: { SessionId: from.id }, attributes: ['id', 'StudentId', 'status'], include: [{ model: Student, attributes: ['id', 'name', 'student_code'] }], transaction }),
      HomeworkCheck.findAll({ where: { SessionId: to.id }, attributes: ['id', 'StudentId', 'status'], transaction }),
      Attendance.findAll({ where: { SessionId: to.id }, attributes: ['StudentId'], raw: true, transaction }),
    ]);
    const targetBy = new Map(target.map(c => [c.StudentId, c]));
    const attendedSet = new Set(attended.map(a => a.StudentId));
    const move = source.filter(c => !targetBy.has(c.StudentId));
    const conflicts = source.filter(c => targetBy.has(c.StudentId)).map(c => ({
      name: c.Student ? c.Student.name : `#${c.StudentId}`,
      code: c.Student ? c.Student.student_code : '',
      oldStatus: STATUS_LABELS[c.status] || c.status,
      newStatus: STATUS_LABELS[targetBy.get(c.StudentId).status] || targetBy.get(c.StudentId).status,
    }));
    out.homework = {
      total: source.length,
      moveIds: move.map(c => c.id),
      move: move.length,
      conflicts,
      notAttendedInTarget: move.filter(c => !attendedSet.has(c.StudentId)).length,
      alreadyInTarget: target.length,
    };
  }

  if (kind !== 'homework') {
    const [exams, targetExams] = await Promise.all([
      Exam.findAll({ where: { SessionId: from.id }, attributes: ['id', 'name', 'max_score', 'exam_date'], transaction }),
      Exam.findAll({ where: { SessionId: to.id }, attributes: ['id', 'name'], transaction }),
    ]);
    const counts = exams.length
      ? await ExamResult.findAll({
        where: { ExamId: { [Op.in]: exams.map(e => e.id) } },
        attributes: ['ExamId', [models.sequelize.fn('COUNT', models.sequelize.col('id')), 'n']],
        group: ['ExamId'], raw: true, transaction,
      })
      : [];
    const countBy = new Map(counts.map(r => [r.ExamId, Number(r.n) || 0]));
    out.exam = {
      exams: exams.map(e => ({ id: e.id, name: e.name, maxScore: e.max_score, date: e.exam_date, results: countBy.get(e.id) || 0 })),
      results: exams.reduce((sum, e) => sum + (countBy.get(e.id) || 0), 0),
      targetExams: targetExams.map(e => e.name),
    };
  }
  return out;
}

async function executeMove(sequelize, models, params) {
  return sequelize.transaction(async (transaction) => {
    const preview = await buildPreview(models, params, transaction);
    if (preview.error) return preview;
    const moved = { homework: 0, exams: 0, results: 0, conflicts: 0 };
    if (preview.homework && preview.homework.moveIds.length) {
      const [n] = await models.HomeworkCheck.update(
        { SessionId: preview.to.id },
        { where: { id: { [Op.in]: preview.homework.moveIds }, SessionId: preview.from.id }, transaction },
      );
      moved.homework = n;
    }
    if (preview.homework) moved.conflicts = preview.homework.conflicts.length;
    if (preview.exam && preview.exam.exams.length) {
      const [n] = await models.Exam.update(
        { SessionId: preview.to.id },
        { where: { id: { [Op.in]: preview.exam.exams.map(e => e.id) }, SessionId: preview.from.id }, transaction },
      );
      moved.exams = n;
      moved.results = preview.exam.results;
    }
    if (!moved.homework && !moved.exams) return { error: 'مفيش حاجة تتنقل من الحصة دي' + (moved.conflicts ? ` (${moved.conflicts} طالب عندهم واجب في الحصة الجديدة بالفعل)` : '') };
    return { preview, moved };
  });
}

module.exports = { KINDS, buildPreview, executeMove };
