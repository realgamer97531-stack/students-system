// درجات اختبار المنصة بتتسجل في جداول الامتحانات العادية (exams + examresults)،
// عشان تظهر في جدول الطالب والمتابعة والتقارير من غير ما كل صفحة تقرا من محاولات الاختبار.
//  - اختبار عادي: امتحان لكل سنتر مربوط بأول حصة في أسبوع الاختبار.
//  - اختبار شامل: امتحان واحد مش مربوط بحصة (بيظهر في قسم الشامل عند الطالب).
// الدرجات هنا مش بتزود نقاط الطالب: دي نسخة من نتيجة الاختبار بس.
const { Op } = require('sequelize');
const Exam = require('../models/Exam');
const ExamResult = require('../models/ExamResult');
const Session = require('../models/Session');
const Student = require('../models/Student');
const PlatformQuiz = require('../models/PlatformQuiz');
const PlatformQuizQuestion = require('../models/PlatformQuizQuestion');
const PlatformQuizAttempt = require('../models/PlatformQuizAttempt');
const PlatformQuizExam = require('../models/PlatformQuizExam');

const SHAMEL_CENTER = 0;

// لو سنتر الطالب لسه معملش حصص الأسبوع ده بناخد حصة نفس الأسبوع من سنتر تاني
async function quizSession(quiz, centerId) {
  const where = { SubjectId: quiz.SubjectId, week_number: quiz.week_number, status: 'normal' };
  const order = [['lesson_number', 'ASC'], ['id', 'ASC']];
  return (await Session.findOne({ where: { ...where, CenterId: centerId }, order })) || Session.findOne({ where, order });
}

async function linkedExam(quiz, centerKey, maxScore, links, examsById) {
  const link = links.find((row) => row.CenterId === centerKey);
  const exam = link ? examsById.get(link.ExamId) : null;
  const session = quiz.is_shamel ? null : await quizSession(quiz, centerKey);

  if (exam) {
    const updates = {};
    if (exam.name !== quiz.title) updates.name = quiz.title;
    if (Number(exam.max_score) !== maxScore) updates.max_score = maxScore;
    if (session && exam.SessionId !== session.id) updates.SessionId = session.id;
    if (Object.keys(updates).length) await exam.update(updates);
    return exam;
  }

  if (!quiz.is_shamel && !session) return null;
  const created = await Exam.create({
    name: quiz.title,
    max_score: maxScore,
    SubjectId: quiz.SubjectId,
    SessionId: session ? session.id : null,
    ...(session && session.session_date ? { exam_date: session.session_date } : {}),
  });
  if (link) await link.update({ ExamId: created.id });
  else links.push(await PlatformQuizExam.create({ QuizId: quiz.id, CenterId: centerKey, ExamId: created.id }));
  examsById.set(created.id, created);
  return created;
}

// آخر محاولة متسلمة هي اللي بتتحسب. من غير studentId = كل طلاب الاختبار.
// skipped = طلاب مفيش حصة في أسبوعهم لسه، بيتسجلوا في أول مزامنة بعد ما الحصة تتعمل
async function syncQuizMarks(quizId, studentId = null) {
  const quiz = await PlatformQuiz.findByPk(quizId);
  if (!quiz) return { synced: 0, skipped: 0 };

  const [questions, attempts, links] = await Promise.all([
    PlatformQuizQuestion.findAll({ where: { QuizId: quiz.id }, attributes: ['marks'] }),
    PlatformQuizAttempt.findAll({
      where: { QuizId: quiz.id, status: 'submitted', ...(studentId ? { StudentId: studentId } : {}) },
      attributes: ['StudentId', 'score'],
      order: [['attempt_no', 'ASC']],
    }),
    PlatformQuizExam.findAll({ where: { QuizId: quiz.id } }),
  ]);
  const examsById = new Map(links.length
    ? (await Exam.findAll({ where: { id: links.map((row) => row.ExamId) } })).map((exam) => [exam.id, exam])
    : []);

  const maxScore = Math.round(questions.reduce((sum, q) => sum + Number(q.marks || 0), 0) * 100) / 100;
  const scoreByStudent = new Map(attempts.map((a) => [a.StudentId, Number(a.score) || 0]));
  const result = { synced: 0, skipped: 0 };

  if (maxScore > 0 && scoreByStudent.size) {
    const students = await Student.findAll({ where: { id: [...scoreByStudent.keys()] }, attributes: ['id', 'CenterId'] });
    const examByCenter = new Map();
    const examOfStudent = new Map();
    for (const student of students) {
      const key = quiz.is_shamel ? SHAMEL_CENTER : student.CenterId;
      if (!examByCenter.has(key)) examByCenter.set(key, await linkedExam(quiz, key, maxScore, links, examsById));
      if (examByCenter.get(key)) examOfStudent.set(student.id, examByCenter.get(key));
      else result.skipped += 1;
    }

    const existing = examsById.size
      ? await ExamResult.findAll({ where: { ExamId: [...examsById.keys()], StudentId: [...examOfStudent.keys()] } })
      : [];
    for (const [id, exam] of examOfStudent) {
      const own = existing.filter((row) => row.StudentId === id);
      const row = own.find((item) => item.ExamId === exam.id);
      const score = scoreByStudent.get(id);
      if (!row) await ExamResult.create({ ExamId: exam.id, StudentId: id, score });
      else if (Number(row.score) !== score) await row.update({ score });
      // الطالب اتنقل لسنتر تاني بعد الاختبار: درجته متفضلش في امتحان السنتر القديم
      const stale = own.filter((item) => item.ExamId !== exam.id).map((item) => item.id);
      if (stale.length) await ExamResult.destroy({ where: { id: stale } });
      result.synced += 1;
    }
  }

  // الاختبار اتغير من عادي لشامل أو العكس: الامتحان القديم الفاضي ميفضلش في صفحة الامتحانات
  if (!studentId) {
    for (const link of links.filter((row) => (row.CenterId === SHAMEL_CENTER) !== Boolean(quiz.is_shamel))) {
      if (!(await ExamResult.count({ where: { ExamId: link.ExamId } }))) {
        await Exam.destroy({ where: { id: link.ExamId } });
        await link.destroy();
      }
    }
  }
  return result;
}

// تسجيل الدرجة خطوة إضافية: لو فشلت متوقعش تسليم الطالب أو التصحيح (مزامنة الدرجات بتعيدها)
async function syncQuizMarksSafe(quizId, studentId = null) {
  try {
    return await syncQuizMarks(quizId, studentId);
  } catch (error) {
    console.error('Platform quiz marks sync failed:', error.message);
    return { synced: 0, skipped: 0, failed: true };
  }
}

async function deleteQuizMarks(quizId, transaction) {
  const links = await PlatformQuizExam.findAll({ where: { QuizId: quizId }, transaction });
  const examIds = links.map((row) => row.ExamId);
  if (examIds.length) {
    await ExamResult.destroy({ where: { ExamId: { [Op.in]: examIds } }, transaction });
    await Exam.destroy({ where: { id: { [Op.in]: examIds } }, transaction });
  }
  await PlatformQuizExam.destroy({ where: { QuizId: quizId }, transaction });
}

module.exports = { syncQuizMarks, syncQuizMarksSafe, deleteQuizMarks };
