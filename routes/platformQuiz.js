// اختبار على المنصة (بديل رابط جوجل فورم):
//  - زرار لكل مادة: لو اتفتح، الاختبار ده بيحل محل روابط الاختبار القديمة، ولو اتقفل النظام القديم بيرجع زي ما هو.
//  - المساعد بيعمل الأسئلة (صورة و/أو نص فيه معادلات)، اختياري/مقالي/بونص، ودرجة لكل سؤال.
//  - الاختبار بيظهر جوه أسبوع معين وبيقفل حصص الأسبوع ده لحد ما الطالب يسلّمه.
//  - محاولة واحدة بس، إلا لو الأدمن سمح بإعادة لطالب أو للكل.
// الإجابات الصحيحة وفيديو الشرح مبيتبعتوش للطالب غير بعد التسليم.

const multer = require('multer');
const { Op } = require('sequelize');
const PlatformQuiz = require('../models/PlatformQuiz');
const PlatformQuizQuestion = require('../models/PlatformQuizQuestion');
const PlatformQuizAttempt = require('../models/PlatformQuizAttempt');
const PlatformQuizSetting = require('../models/PlatformQuizSetting');
const PlatformQuizPayment = require('../models/PlatformQuizPayment');
const { uploadQuizImage, quizUploadConfigured } = require('../utils/quizImageUpload');
const { syncQuizMarks, syncQuizMarksSafe, deleteQuizMarks } = require('../utils/platformQuizMarks');

const QUESTION_TYPES = ['mcq', 'essay', 'bonus'];
const MAX_QUESTIONS = 100;
const MAX_CHOICES = 6;
const DEADLINE_GRACE_MS = 30 * 1000; // سماح بسيط للشبكة بعد انتهاء الوقت
const PORTAL_QUIZ_URL = 'https://shadyelsharkawy.com/quiz.html';

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function cleanUrl(value) {
  const url = String(value || '').trim().slice(0, 1000);
  return /^https?:\/\//i.test(url) ? url : null;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function quizCenterIds(quiz) {
  const ids = parseJson(quiz.center_ids, null);
  return Array.isArray(ids) && ids.length ? ids.map(Number) : null;
}

function quizAppliesToStudent(quiz, student) {
  if (Number(quiz.SubjectId) !== Number(student.SubjectId)) return false;
  const centers = quizCenterIds(quiz);
  return !centers || centers.includes(Number(student.CenterId));
}

function questionChoices(question) {
  const list = parseJson(question.choices, []);
  return Array.isArray(list) ? list : [];
}

// درجة كل سؤال من إجابات الطالب. التصحيحات اليدوية القديمة للمقالي بتفضل زي ما هي.
function gradeAttempt(questions, answers, previousResults) {
  const results = {};
  let score = 0;
  let maxScore = 0;
  let pending = 0;
  questions.forEach((q) => {
    const max = round2(q.marks);
    const answer = answers[q.id] || {};
    const old = previousResults && previousResults[q.id];
    let entry;
    if (q.type === 'bonus' || (q.type === 'essay' && !q.requires_answer)) {
      entry = { earned: max, max, correct: true };
    } else if (q.type === 'mcq') {
      const choice = Number.isInteger(answer.choice) ? answer.choice : null;
      const correct = choice !== null && choice === q.correct_index;
      entry = { earned: correct ? max : 0, max, correct, unanswered: choice === null };
    } else {
      const hasAnswer = Boolean(String(answer.text || '').trim() || answer.image);
      if (old && old.graded) entry = { ...old, max, earned: Math.min(old.earned, max) };
      else if (!hasAnswer) entry = { earned: 0, max, correct: false, unanswered: true };
      else entry = { earned: 0, max, pending: true };
    }
    if (entry.pending) pending += 1;
    results[q.id] = entry;
    score += entry.earned;
    maxScore += max;
  });
  return { results, score: round2(score), maxScore: round2(maxScore), pending };
}

function sanitizeAnswers(input, questions) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  questions.forEach((q) => {
    const a = src[q.id] || src[String(q.id)];
    if (!a || typeof a !== 'object') return;
    if (q.type === 'mcq') {
      const choice = Number.parseInt(a.choice, 10);
      if (Number.isInteger(choice) && choice >= 0 && choice < questionChoices(q).length) out[q.id] = { choice };
    } else if (q.type === 'essay' && q.requires_answer) {
      const text = String(a.text || '').slice(0, 5000);
      const image = cleanUrl(a.image);
      if (text.trim() || image) out[q.id] = { text, ...(image ? { image } : {}) };
    }
  });
  return out;
}

function canRedo(quiz, latest) {
  if (!latest || latest.status !== 'submitted') return false;
  if (latest.redo_allowed) return true;
  // <= لأن DATETIME بيتخزن بالثانية: تسليم في نفس ثانية "إعادة للكل" يتحسب قبلها
  return Boolean(quiz.redo_all_at && latest.submitted_at && new Date(latest.submitted_at) <= new Date(quiz.redo_all_at));
}

function attemptDeadlinePassed(attempt, now = Date.now()) {
  return Boolean(attempt.deadline_at) && new Date(attempt.deadline_at).getTime() + DEADLINE_GRACE_MS < now;
}

async function loadQuestions(quizId) {
  return PlatformQuizQuestion.findAll({ where: { QuizId: quizId }, order: [['order_index', 'ASC'], ['id', 'ASC']] });
}

// تسليم المحاولة (من الطالب أو تلقائي لما الوقت يخلص). مرة واحدة بس حتى لو اتبعت مرتين.
async function finalizeAttempt(attempt, questions, answers, autoSubmitted) {
  const graded = gradeAttempt(questions, answers, null);
  const [count] = await PlatformQuizAttempt.update({
    status: 'submitted',
    submitted_at: new Date(),
    answers: JSON.stringify(answers),
    results: JSON.stringify(graded.results),
    score: graded.score,
    max_score: graded.maxScore,
    pending_count: graded.pending,
    auto_submitted: Boolean(autoSubmitted),
  }, { where: { id: attempt.id, status: 'in_progress' } });
  if (count > 0) await syncQuizMarksSafe(attempt.QuizId, attempt.StudentId);
  return PlatformQuizAttempt.findByPk(attempt.id).then((fresh) => ({ attempt: fresh, changed: count > 0 }));
}

// المحاولات اللي وقتها خلص من غير تسليم بتتسلم تلقائي بالإجابات المحفوظة
async function expireAttempts(attempts) {
  const out = [];
  for (const attempt of attempts) {
    if (attempt.status === 'in_progress' && attemptDeadlinePassed(attempt)) {
      const questions = await loadQuestions(attempt.QuizId);
      const { attempt: fresh } = await finalizeAttempt(attempt, questions, parseJson(attempt.answers, {}), true);
      out.push(fresh);
    } else {
      out.push(attempt);
    }
  }
  return out;
}

async function enabledSubjectIds() {
  const rows = await PlatformQuizSetting.findAll({ where: { enabled: true }, attributes: ['SubjectId'] });
  return new Set(rows.map((r) => Number(r.SubjectId)));
}

async function isSubjectEnabled(subjectId) {
  if (!subjectId) return false;
  const row = await PlatformQuizSetting.findByPk(subjectId, { attributes: ['enabled'] });
  return Boolean(row && row.enabled);
}

function quizPrice(quiz) {
  return quiz.is_shamel ? round2(quiz.price) : 0;
}

function summarizeForStudent(quiz, attempts, questionCount, totalMarks, paid = false) {
  const sorted = [...attempts].sort((a, b) => b.attempt_no - a.attempt_no);
  const latest = sorted[0] || null;
  const lastSubmitted = sorted.find((a) => a.status === 'submitted') || null;
  const inProgress = latest && latest.status === 'in_progress' ? latest : null;
  return {
    id: quiz.id,
    title: quiz.title,
    weekNumber: quiz.week_number,
    timeLimitMinutes: quiz.time_limit_minutes || null,
    questionCount,
    totalMarks: round2(totalMarks),
    status: inProgress ? 'in_progress' : (lastSubmitted ? 'submitted' : 'not_started'),
    locked: !quiz.is_shamel && !lastSubmitted, // الأسبوع مقفول لحد أول تسليم
    isShamel: Boolean(quiz.is_shamel),
    price: quizPrice(quiz),
    requiresPayment: quizPrice(quiz) > 0 && !paid,
    score: lastSubmitted ? round2(lastSubmitted.score) : null,
    maxScore: lastSubmitted ? round2(lastSubmitted.max_score) : null,
    pendingCount: lastSubmitted ? lastSubmitted.pending_count : 0,
    redoAvailable: !inProgress && canRedo(quiz, latest),
    answerVideoUrl: lastSubmitted ? (quiz.answer_video_url || null) : null,
    url: `${PORTAL_QUIZ_URL}?id=${quiz.id}`,
  };
}

// كل اختبارات الطالب (لصفحة الدروس): المادة لازم تكون مفعلة والاختبار منشور
async function studentQuizContext(student) {
  if (!student || !(await isSubjectEnabled(student.SubjectId))) return { enabled: false, quizzes: [], shamelQuizzes: [], lockedWeeks: new Set() };
  const quizzes = (await PlatformQuiz.findAll({ where: { SubjectId: student.SubjectId, is_published: true } }))
    .filter((quiz) => quizAppliesToStudent(quiz, student));
  if (!quizzes.length) return { enabled: true, quizzes: [], shamelQuizzes: [], lockedWeeks: new Set() };
  const quizIds = quizzes.map((q) => q.id);
  const [attemptsRaw, questions, payments] = await Promise.all([
    PlatformQuizAttempt.findAll({ where: { QuizId: quizIds, StudentId: student.id } }),
    PlatformQuizQuestion.findAll({ where: { QuizId: quizIds }, attributes: ['QuizId', 'marks'] }),
    PlatformQuizPayment.findAll({ where: { QuizId: quizIds, StudentId: student.id }, attributes: ['QuizId'] }),
  ]);
  const attempts = await expireAttempts(attemptsRaw);
  const paidQuizIds = new Set(payments.map((p) => p.QuizId));
  const summaries = quizzes.map((quiz) => {
    const own = questions.filter((q) => q.QuizId === quiz.id);
    return summarizeForStudent(
      quiz,
      attempts.filter((a) => a.QuizId === quiz.id),
      own.length,
      own.reduce((sum, q) => sum + Number(q.marks || 0), 0),
      paidQuizIds.has(quiz.id),
    );
  }).sort((a, b) => a.weekNumber - b.weekNumber || a.id - b.id);
  const lockedWeeks = new Set(summaries.filter((s) => s.locked).map((s) => Number(s.weekNumber)));
  return {
    enabled: true,
    quizzes: summaries.filter((s) => !s.isShamel),
    shamelQuizzes: summaries.filter((s) => s.isShamel),
    lockedWeeks,
  };
}

// هل الحصة دي مقفولة على الطالب لحد ما يحل اختبار؟ (بيتنادي من فتح الفيديو/أجزاءه)
async function quizLockForSession(student, session) {
  if (!student || !session) return null;
  const week = Number(session.week_number);
  if (!Number.isInteger(week) || week <= 0) return null;
  if (Number(session.SubjectId) !== Number(student.SubjectId)) return null;
  if (!(await isSubjectEnabled(student.SubjectId))) return null;
  const quizzes = (await PlatformQuiz.findAll({ where: { SubjectId: student.SubjectId, week_number: week, is_published: true, is_shamel: false } }))
    .filter((quiz) => quizAppliesToStudent(quiz, student));
  if (!quizzes.length) return null;
  const attempts = await expireAttempts(await PlatformQuizAttempt.findAll({
    where: { QuizId: quizzes.map((q) => q.id), StudentId: student.id },
  }));
  return quizzes.find((quiz) => !attempts.some((a) => a.QuizId === quiz.id && a.status === 'submitted')) || null;
}

// السؤال زي ما الطالب بيشوفه (من غير الإجابة الصحيحة إلا بعد التسليم)
function publicQuestion(q, reveal) {
  return {
    id: q.id,
    type: q.type,
    text: q.text || '',
    image: q.image_url || null,
    marks: round2(q.marks),
    requiresAnswer: q.type === 'essay' ? Boolean(q.requires_answer) : q.type === 'mcq',
    choices: q.type === 'mcq' ? questionChoices(q).map((c) => ({ text: c.text || '', image: c.image || null })) : [],
    ...(reveal && q.type === 'mcq' ? { correctIndex: q.correct_index } : {}),
  };
}

function readQuizBody(body) {
  const centerIds = [...new Set((Array.isArray(body.center_ids) ? body.center_ids : []).map(Number).filter(Boolean))];
  const time = Number.parseInt(body.time_limit_minutes, 10);
  const isShamel = body.is_shamel === true || body.is_shamel === '1' || body.is_shamel === 'true';
  const price = Number(body.price);
  return {
    is_shamel: isShamel,
    price: isShamel && Number.isFinite(price) && price > 0 ? round2(price) : null,
    SubjectId: Number(body.subject_id) || null,
    week_number: Number.parseInt(body.week_number, 10),
    center_ids: centerIds.length ? JSON.stringify(centerIds) : null,
    title: String(body.title || '').trim().slice(0, 200),
    instructions: String(body.instructions || '').trim().slice(0, 5000) || null,
    time_limit_minutes: Number.isInteger(time) && time > 0 ? Math.min(time, 600) : null,
    answer_video_url: cleanUrl(body.answer_video_url),
  };
}

function readQuestions(list) {
  if (!Array.isArray(list)) return { error: 'مفيش أسئلة' };
  if (!list.length) return { error: 'ضيف سؤال واحد على الأقل' };
  if (list.length > MAX_QUESTIONS) return { error: `أقصى عدد ${MAX_QUESTIONS} سؤال` };
  const questions = [];
  for (let i = 0; i < list.length; i += 1) {
    const src = list[i] || {};
    const n = i + 1;
    const type = QUESTION_TYPES.includes(src.type) ? src.type : 'mcq';
    const text = String(src.text || '').slice(0, 20000);
    const image = cleanUrl(src.image);
    const marks = Number(src.marks);
    if (!text.trim() && !image) return { error: `سؤال ${n}: اكتب السؤال أو ارفع صورة` };
    if (!Number.isFinite(marks) || marks < 0 || marks > 1000) return { error: `سؤال ${n}: الدرجة مش صحيحة` };
    const q = {
      id: Number(src.id) || null,
      order_index: i,
      type,
      text: text.trim() ? text : null,
      image_url: image,
      marks: round2(marks),
      choices: null,
      correct_index: null,
      requires_answer: type === 'essay' && Boolean(src.requiresAnswer),
    };
    if (type === 'mcq') {
      const choices = (Array.isArray(src.choices) ? src.choices : []).slice(0, MAX_CHOICES)
        .map((c) => ({ text: String((c && c.text) || '').slice(0, 5000), image: cleanUrl(c && c.image) }));
      if (choices.length < 2) return { error: `سؤال ${n}: لازم اختيارين على الأقل` };
      if (choices.some((c) => !c.text.trim() && !c.image)) return { error: `سؤال ${n}: كل اختيار لازم يبقى له نص أو صورة` };
      const correct = Number.parseInt(src.correctIndex, 10);
      if (!Number.isInteger(correct) || correct < 0 || correct >= choices.length) return { error: `سؤال ${n}: اختار الإجابة الصحيحة` };
      q.choices = JSON.stringify(choices.map((c) => ({ text: c.text, ...(c.image ? { image: c.image } : {}) })));
      q.correct_index = correct;
    }
    questions.push(q);
  }
  return { questions };
}

module.exports = function registerPlatformQuizRoutes(app, deps) {
  const { requirePermissionOrAdmin, verifyPortalToken, adjustStudentBalance, Student, Subject, Center, Session, BalanceTransaction } = deps;
  // صلاحية "اختبارات المنصة" بتدي الصفحة كلها، واللي معاه إدارة الفيديوهات من قبل كده لسه داخل زي ما هو
  const adminGuard = requirePermissionOrAdmin(['platform_quizzes', 'admin_videos']);

  // ================= الأدمن =================

  async function subjectsWithCenters() {
    const [subjects, centers, sessions] = await Promise.all([
      Subject.findAll({ attributes: ['id', 'name'], order: [['name', 'ASC']] }),
      Center.findAll({ attributes: ['id', 'name'], order: [['name', 'ASC']] }),
      Session.findAll({ attributes: ['SubjectId', 'CenterId', 'week_number'], group: ['SubjectId', 'CenterId', 'week_number'], raw: true }),
    ]);
    const centerById = new Map(centers.map((c) => [c.id, c.name]));
    return subjects.map((s) => {
      const own = sessions.filter((row) => Number(row.SubjectId) === s.id);
      const centerIds = [...new Set(own.map((row) => Number(row.CenterId)).filter((id) => centerById.has(id)))];
      const weeks = [...new Set(own.map((row) => Number(row.week_number)).filter((w) => Number.isInteger(w) && w > 0))].sort((a, b) => a - b);
      return { id: s.id, name: s.name, centers: centerIds.map((id) => ({ id, name: centerById.get(id) })), weeks };
    });
  }

  app.get('/admin/platform-quizzes', adminGuard, async (req, res) => {
    try {
      const [subjects, enabled, quizzes] = await Promise.all([
        subjectsWithCenters(),
        enabledSubjectIds(),
        PlatformQuiz.findAll({ order: [['SubjectId', 'ASC'], ['week_number', 'DESC'], ['id', 'DESC']] }),
      ]);
      const quizIds = quizzes.map((q) => q.id);
      const [questionCounts, attemptRows] = quizIds.length ? await Promise.all([
        PlatformQuizQuestion.findAll({ where: { QuizId: quizIds }, attributes: ['QuizId'], raw: true }),
        PlatformQuizAttempt.findAll({ where: { QuizId: quizIds }, attributes: ['QuizId', 'StudentId', 'status', 'pending_count'], raw: true }),
      ]) : [[], []];
      const stats = {};
      quizIds.forEach((id) => { stats[id] = { questions: 0, students: new Set(), pending: 0 }; });
      questionCounts.forEach((row) => { stats[row.QuizId].questions += 1; });
      attemptRows.forEach((row) => {
        if (row.status === 'submitted') stats[row.QuizId].students.add(row.StudentId);
        stats[row.QuizId].pending += Number(row.pending_count || 0);
      });
      res.render('platform-quizzes', {
        subjects,
        enabledIds: [...enabled],
        quizzes: quizzes.map((q) => ({
          id: q.id, SubjectId: q.SubjectId, week: q.week_number, title: q.title, published: q.is_published,
          isShamel: Boolean(q.is_shamel), price: quizPrice(q),
          centerIds: quizCenterIds(q), timeLimit: q.time_limit_minutes,
          questions: stats[q.id].questions, submitted: stats[q.id].students.size, pending: stats[q.id].pending,
        })),
        uploadReady: quizUploadConfigured(),
      });
    } catch (error) {
      console.error('Platform quizzes list failed:', error);
      res.status(500).send('❌ حصلت مشكلة: ' + error.message);
    }
  });

  // زرار التشغيل لكل مادة
  app.post('/admin/platform-quizzes/settings/:subjectId', adminGuard, async (req, res) => {
    try {
      const subjectId = Number(req.params.subjectId);
      if (!subjectId || !(await Subject.findByPk(subjectId, { attributes: ['id'] }))) return res.status(404).json({ success: false, message: 'المادة مش موجودة' });
      const enabled = req.body.enabled === true || req.body.enabled === '1' || req.body.enabled === 'true';
      await PlatformQuizSetting.upsert({ SubjectId: subjectId, enabled });
      res.json({ success: true, enabled });
    } catch (error) {
      console.error('Platform quiz toggle failed:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  async function renderBuilder(res, quiz) {
    const subjects = await subjectsWithCenters();
    let data = null;
    if (quiz) {
      const [questions, attemptCount] = await Promise.all([
        loadQuestions(quiz.id),
        PlatformQuizAttempt.count({ where: { QuizId: quiz.id } }),
      ]);
      data = {
        id: quiz.id,
        subjectId: quiz.SubjectId,
        week: quiz.week_number,
        isShamel: Boolean(quiz.is_shamel),
        price: quiz.price || '',
        centerIds: quizCenterIds(quiz) || [],
        title: quiz.title,
        instructions: quiz.instructions || '',
        timeLimit: quiz.time_limit_minutes || '',
        answerVideoUrl: quiz.answer_video_url || '',
        published: quiz.is_published,
        attemptCount,
        questions: questions.map((q) => ({
          id: q.id, type: q.type, text: q.text || '', image: q.image_url || '', marks: Number(q.marks),
          requiresAnswer: Boolean(q.requires_answer), choices: questionChoices(q), correctIndex: q.correct_index,
        })),
      };
    }
    res.render('platform-quiz-builder', { subjects, quiz: data, uploadReady: quizUploadConfigured() });
  }

  app.get('/admin/platform-quizzes/new', adminGuard, async (req, res) => {
    try { await renderBuilder(res, null); } catch (error) { res.status(500).send('❌ حصلت مشكلة: ' + error.message); }
  });

  app.get('/admin/platform-quizzes/:id/edit', adminGuard, async (req, res) => {
    try {
      const quiz = await PlatformQuiz.findByPk(req.params.id);
      if (!quiz) return res.status(404).send('❌ الاختبار مش موجود');
      await renderBuilder(res, quiz);
    } catch (error) {
      res.status(500).send('❌ حصلت مشكلة: ' + error.message);
    }
  });

  app.post('/admin/platform-quizzes/upload-image', adminGuard, imageUpload.single('image'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, message: 'اختار صورة' });
      const url = await uploadQuizImage(req.file, 'questions');
      res.json({ success: true, url });
    } catch (error) {
      console.error('Quiz image upload failed:', error.message);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // حفظ (جديد أو تعديل) — الأسئلة بتتعدل في مكانها عشان إجابات الطلاب المحفوظة متضيعش
  async function saveQuiz(req, res, existing) {
    const fields = readQuizBody(req.body || {});
    if (!fields.SubjectId || !(await Subject.findByPk(fields.SubjectId, { attributes: ['id'] }))) return res.status(400).json({ success: false, message: 'اختار المادة' });
    if (!Number.isInteger(fields.week_number) || fields.week_number <= 0) return res.status(400).json({ success: false, message: 'اختار الأسبوع اللي الاختبار هيظهر فيه' });
    if (!fields.title) return res.status(400).json({ success: false, message: 'اكتب اسم الاختبار' });
    const parsed = readQuestions(req.body.questions);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    const sequelize = PlatformQuiz.sequelize;
    const saved = await sequelize.transaction(async (transaction) => {
      let quiz = existing;
      if (quiz) await quiz.update(fields, { transaction });
      else quiz = await PlatformQuiz.create({ ...fields, is_published: false, created_by: req.session.userId || null }, { transaction });

      const current = await PlatformQuizQuestion.findAll({ where: { QuizId: quiz.id }, transaction });
      const currentIds = new Set(current.map((q) => q.id));
      const keptIds = new Set();
      const questionIds = [];
      for (const q of parsed.questions) {
        const { id, ...values } = q;
        if (id && currentIds.has(id) && !keptIds.has(id)) {
          await PlatformQuizQuestion.update(values, { where: { id, QuizId: quiz.id }, transaction });
          keptIds.add(id);
          questionIds.push(id);
        } else {
          const created = await PlatformQuizQuestion.create({ ...values, QuizId: quiz.id }, { transaction });
          questionIds.push(created.id);
        }
      }
      const removed = current.filter((q) => !keptIds.has(q.id)).map((q) => q.id);
      if (removed.length) await PlatformQuizQuestion.destroy({ where: { id: removed, QuizId: quiz.id }, transaction });
      return { quizId: quiz.id, questionIds };
    });
    if (existing) await syncQuizMarksSafe(saved.quizId); // الاسم أو الأسبوع أو الدرجة النهائية ممكن يكونوا اتغيروا
    // عدد المحاولات عشان صفحة التعديل تسأل عن إعادة التصحيح
    const attemptCount = await PlatformQuizAttempt.count({ where: { QuizId: saved.quizId, status: 'submitted' } });
    res.json({ success: true, id: saved.quizId, questionIds: saved.questionIds, attemptCount });
  }

  // بينقل درجات كل الاختبارات لجدول الطالب (الدرجات القديمة + اللي أسبوعها مكانش فيه حصص وقت التسليم)
  app.post('/admin/platform-quizzes/sync-marks', adminGuard, async (req, res) => {
    try {
      const quizzes = await PlatformQuiz.findAll({ attributes: ['id'] });
      const total = { synced: 0, skipped: 0 };
      for (const quiz of quizzes) {
        const result = await syncQuizMarks(quiz.id);
        total.synced += result.synced;
        total.skipped += result.skipped;
      }
      res.json({ success: true, ...total });
    } catch (error) {
      console.error('Platform quiz marks sync failed:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post('/admin/platform-quizzes', adminGuard, async (req, res) => {
    try { await saveQuiz(req, res, null); } catch (error) {
      console.error('Platform quiz create failed:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post('/admin/platform-quizzes/:id', adminGuard, async (req, res) => {
    try {
      const quiz = await PlatformQuiz.findByPk(req.params.id);
      if (!quiz) return res.status(404).json({ success: false, message: 'الاختبار مش موجود' });
      await saveQuiz(req, res, quiz);
    } catch (error) {
      console.error('Platform quiz update failed:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post('/admin/platform-quizzes/:id/publish', adminGuard, async (req, res) => {
    try {
      const quiz = await PlatformQuiz.findByPk(req.params.id);
      if (!quiz) return res.status(404).json({ success: false, message: 'الاختبار مش موجود' });
      const publish = req.body.published === true || req.body.published === '1' || req.body.published === 'true';
      if (publish && !(await PlatformQuizQuestion.count({ where: { QuizId: quiz.id } }))) {
        return res.status(400).json({ success: false, message: 'الاختبار مفيهوش أسئلة' });
      }
      await quiz.update({ is_published: publish });
      res.json({ success: true, published: publish });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post('/admin/platform-quizzes/:id/delete', adminGuard, async (req, res) => {
    try {
      const quiz = await PlatformQuiz.findByPk(req.params.id);
      if (!quiz) return res.redirect('/admin/platform-quizzes');
      await PlatformQuiz.sequelize.transaction(async (transaction) => {
        await deleteQuizMarks(quiz.id, transaction);
        await PlatformQuizAttempt.destroy({ where: { QuizId: quiz.id }, transaction });
        await PlatformQuizQuestion.destroy({ where: { QuizId: quiz.id }, transaction });
        await quiz.destroy({ transaction });
      });
      res.redirect('/admin/platform-quizzes');
    } catch (error) {
      res.status(500).send('❌ حصلت مشكلة: ' + error.message);
    }
  });

  // النتايج + تصحيح المقالي + الإعادة
  app.get('/admin/platform-quizzes/:id/results', adminGuard, async (req, res) => {
    try {
      const quiz = await PlatformQuiz.findByPk(req.params.id);
      if (!quiz) return res.status(404).send('❌ الاختبار مش موجود');
      const centerIds = quizCenterIds(quiz);
      const [questions, subject, centers, students, attemptsRaw] = await Promise.all([
        loadQuestions(quiz.id),
        Subject.findByPk(quiz.SubjectId, { attributes: ['id', 'name'] }),
        Center.findAll({ attributes: ['id', 'name'] }),
        Student.findAll({
          where: { SubjectId: quiz.SubjectId, ...(centerIds ? { CenterId: centerIds } : {}) },
          attributes: ['id', 'name', 'student_code', 'CenterId', 'phone'],
          order: [['name', 'ASC']],
        }),
        PlatformQuizAttempt.findAll({ where: { QuizId: quiz.id }, order: [['attempt_no', 'ASC']] }),
      ]);
      const attempts = await expireAttempts(attemptsRaw);
      const centerName = new Map(centers.map((c) => [c.id, c.name]));
      const byStudent = new Map();
      attempts.forEach((a) => {
        if (!byStudent.has(a.StudentId)) byStudent.set(a.StudentId, []);
        byStudent.get(a.StudentId).push(a);
      });
      // طلاب خدوا الاختبار ومش في المجموعة دلوقتي (اتنقلوا مثلًا) بيظهروا برضه
      const known = new Set(students.map((s) => s.id));
      const extraIds = [...byStudent.keys()].filter((id) => !known.has(id));
      const extras = extraIds.length ? await Student.findAll({ where: { id: extraIds }, attributes: ['id', 'name', 'student_code', 'CenterId', 'phone'] }) : [];
      const rows = [...students, ...extras].map((s) => {
        const list = (byStudent.get(s.id) || []).sort((a, b) => b.attempt_no - a.attempt_no);
        const latest = list[0] || null;
        const shown = list.find((a) => a.status === 'submitted') || latest;
        return {
          id: s.id, name: s.name, code: s.student_code, phone: s.phone, center: centerName.get(s.CenterId) || '',
          attemptId: shown ? shown.id : null,
          attempts: list.length,
          status: latest ? latest.status : 'not_started',
          score: shown && shown.status === 'submitted' ? round2(shown.score) : null,
          maxScore: shown && shown.status === 'submitted' ? round2(shown.max_score) : null,
          pending: shown && shown.status === 'submitted' ? shown.pending_count : 0,
          submittedAt: shown ? shown.submitted_at : null,
          autoSubmitted: Boolean(shown && shown.auto_submitted),
          redoAllowed: canRedo(quiz, latest),
          redoOwn: Boolean(latest && latest.redo_allowed),
        };
      });
      // إجابات المقالي اللي محتاجة تصحيح
      const qById = new Map(questions.map((q) => [q.id, q]));
      const nameById = new Map([...students, ...extras].map((s) => [s.id, s]));
      const pendingItems = [];
      attempts.filter((a) => a.status === 'submitted' && a.pending_count > 0).forEach((a) => {
        const answers = parseJson(a.answers, {});
        const results = parseJson(a.results, {});
        Object.entries(results).forEach(([qid, r]) => {
          const q = qById.get(Number(qid));
          if (!r.pending || !q) return;
          const s = nameById.get(a.StudentId);
          pendingItems.push({
            attemptId: a.id, questionId: q.id, order: questions.indexOf(q) + 1, max: r.max,
            questionText: q.text || '', questionImage: q.image_url || null,
            studentName: s ? s.name : `#${a.StudentId}`, studentCode: s ? s.student_code : '',
            answerText: (answers[qid] && answers[qid].text) || '', answerImage: (answers[qid] && answers[qid].image) || null,
          });
        });
      });
      const submittedRows = rows.filter((r) => r.score !== null);
      const average = submittedRows.length ? round2(submittedRows.reduce((sum, r) => sum + r.score, 0) / submittedRows.length) : null;
      res.render('platform-quiz-results', {
        quiz: { id: quiz.id, title: quiz.title, week: quiz.week_number, isShamel: Boolean(quiz.is_shamel), published: quiz.is_published, redoAllAt: quiz.redo_all_at },
        subjectName: subject ? subject.name : '',
        totalMarks: round2(questions.reduce((sum, q) => sum + Number(q.marks || 0), 0)),
        rows, pendingItems, average,
      });
    } catch (error) {
      console.error('Platform quiz results failed:', error);
      res.status(500).send('❌ حصلت مشكلة: ' + error.message);
    }
  });

  app.post('/admin/platform-quizzes/:id/grade', adminGuard, async (req, res) => {
    try {
      const attempt = await PlatformQuizAttempt.findOne({ where: { id: req.body.attempt_id, QuizId: req.params.id, status: 'submitted' } });
      if (!attempt) return res.status(404).json({ success: false, message: 'المحاولة مش موجودة' });
      const results = parseJson(attempt.results, {});
      const qid = String(Number(req.body.question_id));
      const entry = results[qid];
      if (!entry) return res.status(400).json({ success: false, message: 'السؤال مش في المحاولة دي' });
      const marks = Number(req.body.marks);
      if (!Number.isFinite(marks) || marks < 0 || marks > entry.max) return res.status(400).json({ success: false, message: `الدرجة من 0 لـ ${entry.max}` });
      results[qid] = { earned: round2(marks), max: entry.max, correct: marks >= entry.max, graded: true, gradedBy: req.session.userId || null, gradedAt: new Date().toISOString() };
      const values = Object.values(results);
      await attempt.update({
        results: JSON.stringify(results),
        score: round2(values.reduce((sum, r) => sum + Number(r.earned || 0), 0)),
        pending_count: values.filter((r) => r.pending).length,
      });
      await syncQuizMarksSafe(attempt.QuizId, attempt.StudentId);
      res.json({ success: true, score: round2(attempt.score), pending: attempt.pending_count });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // إعادة لطالب واحد (allow=0 يلغيها)
  app.post('/admin/platform-quizzes/:id/redo', adminGuard, async (req, res) => {
    try {
      const studentId = Number(req.body.student_id);
      const latest = await PlatformQuizAttempt.findOne({ where: { QuizId: req.params.id, StudentId: studentId }, order: [['attempt_no', 'DESC']] });
      if (!latest || latest.status !== 'submitted') return res.status(400).json({ success: false, message: 'الطالب لسه مسلّمش الاختبار' });
      const allow = !(req.body.allow === false || req.body.allow === '0' || req.body.allow === 'false');
      await latest.update({ redo_allowed: allow });
      res.json({ success: true, allow });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // إعادة للكل: أي حد سلّم قبل دلوقتي يقدر يعيد مرة
  app.post('/admin/platform-quizzes/:id/redo-all', adminGuard, async (req, res) => {
    try {
      const quiz = await PlatformQuiz.findByPk(req.params.id);
      if (!quiz) return res.status(404).json({ success: false, message: 'الاختبار مش موجود' });
      const cancel = req.body.cancel === true || req.body.cancel === '1';
      await quiz.update({ redo_all_at: cancel ? null : new Date() });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // إعادة التصحيح بعد تعديل إجابة صحيحة/درجة (تصحيح المقالي اليدوي بيفضل زي ما هو)
  app.post('/admin/platform-quizzes/:id/regrade', adminGuard, async (req, res) => {
    try {
      const questions = await loadQuestions(req.params.id);
      const attempts = await PlatformQuizAttempt.findAll({ where: { QuizId: req.params.id, status: 'submitted' } });
      for (const attempt of attempts) {
        const graded = gradeAttempt(questions, parseJson(attempt.answers, {}), parseJson(attempt.results, {}));
        await attempt.update({ results: JSON.stringify(graded.results), score: graded.score, max_score: graded.maxScore, pending_count: graded.pending });
      }
      await syncQuizMarksSafe(req.params.id);
      res.json({ success: true, count: attempts.length });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // ================= الطالب =================

  async function loadStudentQuiz(req, res) {
    const student = await Student.findByPk(req.portalStudentId);
    if (!student) { res.status(404).json({ success: false, message: 'غير موجود' }); return null; }
    const quiz = await PlatformQuiz.findByPk(req.params.id);
    if (!quiz || !quiz.is_published || !quizAppliesToStudent(quiz, student) || !(await isSubjectEnabled(quiz.SubjectId))) {
      res.status(404).json({ success: false, message: 'الاختبار ده مش متاح ليك' });
      return null;
    }
    return { student, quiz };
  }

  async function studentAttempts(quizId, studentId) {
    const list = await PlatformQuizAttempt.findAll({ where: { QuizId: quizId, StudentId: studentId }, order: [['attempt_no', 'DESC']] });
    return expireAttempts(list);
  }

  function attemptView(attempt, questions, reveal) {
    return {
      id: attempt.id,
      attemptNo: attempt.attempt_no,
      status: attempt.status,
      startedAt: attempt.started_at,
      deadlineAt: attempt.deadline_at,
      submittedAt: attempt.submitted_at,
      answers: parseJson(attempt.answers, {}),
      ...(reveal ? {
        results: parseJson(attempt.results, {}),
        score: round2(attempt.score),
        maxScore: round2(attempt.max_score),
        pendingCount: attempt.pending_count,
        autoSubmitted: attempt.auto_submitted,
      } : {}),
    };
  }

  app.get('/api/portal/student/quizzes', verifyPortalToken('student'), async (req, res) => {
    try {
      const student = await Student.findByPk(req.portalStudentId);
      if (!student) return res.status(404).json({ success: false, message: 'غير موجود' });
      const context = await studentQuizContext(student);
      res.json({ success: true, enabled: context.enabled, quizzes: context.quizzes, shamelQuizzes: context.shamelQuizzes });
    } catch (error) {
      console.error('Student quizzes failed:', error);
      res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
    }
  });

  app.get('/api/portal/student/quizzes/:id', verifyPortalToken('student'), async (req, res) => {
    try {
      const loaded = await loadStudentQuiz(req, res);
      if (!loaded) return;
      const { student, quiz } = loaded;
      const [questions, attempts, payment] = await Promise.all([
        loadQuestions(quiz.id),
        studentAttempts(quiz.id, student.id),
        PlatformQuizPayment.findOne({ where: { QuizId: quiz.id, StudentId: student.id }, attributes: ['id'] }),
      ]);
      const latest = attempts[0] || null;
      const lastSubmitted = attempts.find((a) => a.status === 'submitted') || null;
      const inProgress = latest && latest.status === 'in_progress' ? latest : null;
      const summary = summarizeForStudent(quiz, attempts, questions.length, questions.reduce((sum, q) => sum + Number(q.marks || 0), 0), Boolean(payment));
      const payload = {
        success: true,
        serverNow: new Date().toISOString(),
        quiz: { ...summary, instructions: quiz.instructions || '' },
      };
      if (inProgress) {
        payload.attempt = attemptView(inProgress, questions, false);
        payload.questions = questions.map((q) => publicQuestion(q, false));
      } else if (lastSubmitted) {
        payload.attempt = attemptView(lastSubmitted, questions, true);
        payload.questions = questions.map((q) => publicQuestion(q, true));
      }
      res.json(payload);
    } catch (error) {
      console.error('Student quiz failed:', error);
      res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
    }
  });

  app.post('/api/portal/student/quizzes/:id/start', verifyPortalToken('student'), async (req, res) => {
    try {
      const loaded = await loadStudentQuiz(req, res);
      if (!loaded) return;
      const { student, quiz } = loaded;
      const attempts = await studentAttempts(quiz.id, student.id);
      const latest = attempts[0] || null;
      if (latest && latest.status === 'in_progress') return res.json({ success: true, attemptId: latest.id });
      if (latest && !canRedo(quiz, latest)) return res.status(409).json({ success: false, message: 'انت حليت الاختبار ده قبل كده' });
      const price = quizPrice(quiz);
      if (price > 0 && !(await PlatformQuizPayment.findOne({ where: { QuizId: quiz.id, StudentId: student.id }, attributes: ['id'] }))) {
        if (!(req.body && req.body.confirm_payment)) {
          return res.json({ success: false, requiresPayment: true, price, message: `الاختبار الشامل ده بـ ${price} ج. هل توافق على دفعهم من رصيدك؟` });
        }
        const payment = await payForQuiz(quiz, student);
        if (payment.insufficient) return res.json({ success: false, message: 'رصيدك غير كافٍ لدفع ثمن الاختبار ده' });
      }
      const now = new Date();
      try {
        const attempt = await PlatformQuizAttempt.create({
          QuizId: quiz.id,
          StudentId: student.id,
          attempt_no: latest ? latest.attempt_no + 1 : 1,
          status: 'in_progress',
          started_at: now,
          deadline_at: quiz.time_limit_minutes ? new Date(now.getTime() + quiz.time_limit_minutes * 60000) : null,
          answers: '{}',
        });
        res.json({ success: true, attemptId: attempt.id });
      } catch (error) {
        // ضغطة مرتين في نفس اللحظة: المحاولة اتعملت بالفعل
        if (error.name === 'SequelizeUniqueConstraintError') {
          const existing = await PlatformQuizAttempt.findOne({ where: { QuizId: quiz.id, StudentId: student.id, status: 'in_progress' } });
          if (existing) return res.json({ success: true, attemptId: existing.id });
        }
        throw error;
      }
    } catch (error) {
      console.error('Student quiz start failed:', error);
      res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
    }
  });

  // دفع الشامل مرة واحدة من رصيد الطالب. نفس طريقة دفع الفيديو: قفل على صف الطالب عشان ضغطتين ميخصموش مرتين
  async function payForQuiz(quiz, student) {
    const price = quizPrice(quiz);
    return PlatformQuiz.sequelize.transaction(async (transaction) => {
      const locked = await Student.findByPk(student.id, { transaction, lock: transaction.LOCK.UPDATE });
      const already = await PlatformQuizPayment.findOne({ where: { QuizId: quiz.id, StudentId: student.id }, transaction });
      if (already) return { paid: true };
      if (Number(locked.balance) < price) return { insufficient: true };
      await adjustStudentBalance(locked, -price, transaction);
      await BalanceTransaction.create({ StudentId: student.id, amount: -price, reason: `اختبار شامل: ${quiz.title}` }, { transaction });
      await PlatformQuizPayment.create({ QuizId: quiz.id, StudentId: student.id, amount: price }, { transaction });
      return { paid: true };
    });
  }

  async function currentAttempt(quizId, studentId) {
    return PlatformQuizAttempt.findOne({ where: { QuizId: quizId, StudentId: studentId, status: 'in_progress' } });
  }

  // حفظ تلقائي للإجابات أثناء الحل (عشان لو النت فصل أو الصفحة اتقفلت)
  app.post('/api/portal/student/quizzes/:id/save', verifyPortalToken('student'), async (req, res) => {
    try {
      const loaded = await loadStudentQuiz(req, res);
      if (!loaded) return;
      const { student, quiz } = loaded;
      const attempt = await currentAttempt(quiz.id, student.id);
      if (!attempt) return res.status(409).json({ success: false, message: 'الاختبار اتسلّم خلاص', submitted: true });
      const questions = await loadQuestions(quiz.id);
      if (attemptDeadlinePassed(attempt)) {
        await finalizeAttempt(attempt, questions, parseJson(attempt.answers, {}), true);
        return res.status(409).json({ success: false, message: 'الوقت خلص والاختبار اتسلّم', submitted: true });
      }
      const answers = sanitizeAnswers(req.body.answers, questions);
      await PlatformQuizAttempt.update({ answers: JSON.stringify(answers) }, { where: { id: attempt.id, status: 'in_progress' } });
      res.json({ success: true });
    } catch (error) {
      console.error('Student quiz save failed:', error);
      res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
    }
  });

  app.post('/api/portal/student/quizzes/:id/submit', verifyPortalToken('student'), async (req, res) => {
    try {
      const loaded = await loadStudentQuiz(req, res);
      if (!loaded) return;
      const { student, quiz } = loaded;
      const attempt = await currentAttempt(quiz.id, student.id);
      if (!attempt) return res.status(409).json({ success: false, message: 'الاختبار اتسلّم خلاص', submitted: true });
      const questions = await loadQuestions(quiz.id);
      // بعد انتهاء الوقت بنعتمد على آخر إجابات اتحفظت بس
      const late = attemptDeadlinePassed(attempt);
      const answers = late ? parseJson(attempt.answers, {}) : sanitizeAnswers(req.body.answers, questions);
      await finalizeAttempt(attempt, questions, answers, late);
      res.json({ success: true });
    } catch (error) {
      console.error('Student quiz submit failed:', error);
      res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
    }
  });

  // صورة إجابة مقالي (حل بخط الإيد مثلًا)
  app.post('/api/portal/student/quizzes/:id/answer-image', verifyPortalToken('student'), imageUpload.single('image'), async (req, res) => {
    try {
      const loaded = await loadStudentQuiz(req, res);
      if (!loaded) return;
      const { student, quiz } = loaded;
      const attempt = await currentAttempt(quiz.id, student.id);
      if (!attempt || attemptDeadlinePassed(attempt)) return res.status(409).json({ success: false, message: 'الاختبار اتسلّم خلاص', submitted: true });
      if (!req.file) return res.status(400).json({ success: false, message: 'اختار صورة' });
      const url = await uploadQuizImage(req.file, 'answers');
      res.json({ success: true, url });
    } catch (error) {
      console.error('Student quiz answer image failed:', error.message);
      res.status(500).json({ success: false, message: 'فشل رفع الصورة، جرب تاني' });
    }
  });
};

module.exports.studentQuizContext = studentQuizContext;
module.exports.quizLockForSession = quizLockForSession;
module.exports.gradeAttempt = gradeAttempt;
module.exports.PORTAL_QUIZ_URL = PORTAL_QUIZ_URL;
