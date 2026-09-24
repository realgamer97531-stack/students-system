// الأسئلة المنبثقة (Popup Questions) داخل صفحة الدرس:
//  - أدمن/مساعد (صلاحية admin_videos): إدارة الأسئلة + التصميم + الإحصائيات + تصحيح المقالي
//  - الطالب: جلب الأسئلة، الإجابة (اختياري/مقالي)، ونتائجه لعرضها في lessons.html
// الإجابة الصحيحة ولينك فيديو الحل بيتبعتوا للطالب بعد ما يجاوب بس.

const multer = require('multer');
const PopupQuestion = require('../models/PopupQuestion');
const PopupQuestionAnswer = require('../models/PopupQuestionAnswer');

const CHOICES = ['a', 'b', 'c', 'd'];

const DEFAULT_DESIGN = {
  bgColor: '#ffffff',
  textColor: '#0f172a',
  accentColor: '#6366f1',
  choiceBgColor: '#f1f5f9',
  correctColor: '#16a34a',
  wrongColor: '#dc2626',
  overlayOpacity: 70,
  fontSize: 20,
  borderRadius: 20,
  fontFamily: 'Cairo, Segoe UI, Tahoma, sans-serif',
  headerText: '',
};

const FONT_FAMILIES = [
  'Cairo, Segoe UI, Tahoma, sans-serif',
  'Segoe UI, Tahoma, sans-serif',
  'Georgia, serif',
  'Courier New, monospace',
];

function isColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value.trim());
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeDesign(input) {
  const src = input && typeof input === 'object' ? input : {};
  const design = { ...DEFAULT_DESIGN };
  ['bgColor', 'textColor', 'accentColor', 'choiceBgColor', 'correctColor', 'wrongColor'].forEach((key) => {
    if (isColor(src[key])) design[key] = src[key].trim();
  });
  design.overlayOpacity = clampInt(src.overlayOpacity, 0, 95, DEFAULT_DESIGN.overlayOpacity);
  design.fontSize = clampInt(src.fontSize, 14, 40, DEFAULT_DESIGN.fontSize);
  design.borderRadius = clampInt(src.borderRadius, 0, 40, DEFAULT_DESIGN.borderRadius);
  if (FONT_FAMILIES.includes(src.fontFamily)) design.fontFamily = src.fontFamily;
  design.headerText = String(src.headerText || '').slice(0, 80);
  return design;
}

function parseDesign(text) {
  if (!text) return { ...DEFAULT_DESIGN };
  try { return sanitizeDesign(JSON.parse(text)); } catch (_) { return { ...DEFAULT_DESIGN }; }
}

function secondsFrom(body, prefix) {
  // بيقبل <prefix>_seconds مباشرة (الفورم بيجمع دقايق/ثواني في JS)
  return clampInt(body[`${prefix}_seconds`], 0, 86400, 0);
}

function solutionPayload(q) {
  if (!q.solution_video_url) return null;
  return {
    url: q.solution_video_url,
    start: q.solution_start_seconds || 0,
    end: q.solution_end_seconds || 0,
    minSeconds: q.solution_min_seconds || 0,
  };
}

module.exports = function registerPopupQuestionRoutes(app, deps) {
  const {
    requirePermissionOrAdmin, verifyPortalToken, hasAllVideoAccess, addPoints, uploadBufferToCloudinary,
    adImageUpload, Student, Video, VideoPart, Session, VideoSession, VideoStudentAccess, Subject, Center,
  } = deps;

  const essayUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
  });

  const adminGuard = requirePermissionOrAdmin('admin_videos');

  // ================= الأدمن =================

  function readQuestionBody(body) {
    const type = body.question_type === 'essay' ? 'essay' : 'mcq';
    const triggerType = body.trigger_type === 'time' ? 'time' : 'end';
    const fields = {
      title: String(body.title || '').trim().slice(0, 200) || null,
      question_type: type,
      trigger_type: triggerType,
      trigger_seconds: triggerType === 'time' ? secondsFrom(body, 'trigger') : 0,
      question_text: String(body.question_text || '').trim(),
      solution_video_url: String(body.solution_video_url || '').trim().slice(0, 1000) || null,
      solution_start_seconds: secondsFrom(body, 'solution_start'),
      solution_end_seconds: secondsFrom(body, 'solution_end'),
      solution_min_seconds: secondsFrom(body, 'solution_min'),
      bonus_points: clampInt(body.bonus_points, 0, 1000, 5),
      is_active: body.is_active === undefined ? true : (body.is_active === 'on' || body.is_active === '1' || body.is_active === 'true'),
      design: JSON.stringify(sanitizeDesign({
        bgColor: body.d_bgColor, textColor: body.d_textColor, accentColor: body.d_accentColor,
        choiceBgColor: body.d_choiceBgColor, correctColor: body.d_correctColor, wrongColor: body.d_wrongColor,
        overlayOpacity: body.d_overlayOpacity, fontSize: body.d_fontSize, borderRadius: body.d_borderRadius,
        fontFamily: body.d_fontFamily, headerText: body.d_headerText,
      })),
    };
    if (type === 'mcq') {
      CHOICES.forEach((c) => { fields[`choice_${c}`] = String(body[`choice_${c}`] || '').trim(); });
      fields.correct_choice = CHOICES.includes(body.correct_choice) ? body.correct_choice : null;
    } else {
      CHOICES.forEach((c) => { fields[`choice_${c}`] = null; });
      fields.correct_choice = null;
    }
    return fields;
  }

  function validateQuestionFields(fields) {
    if (!fields.question_text) return 'اكتب نص السؤال';
    if (fields.question_type === 'mcq') {
      if (CHOICES.some((c) => !fields[`choice_${c}`])) return 'لازم تكتب الاختيارات الأربعة';
      if (!fields.correct_choice) return 'اختار الإجابة الصحيحة';
    }
    if (fields.solution_end_seconds && fields.solution_end_seconds <= fields.solution_start_seconds) {
      return 'وقت نهاية فيديو الحل لازم يكون بعد وقت البداية';
    }
    return null;
  }

  async function renderForm(res, video, question, error) {
    const parts = await VideoPart.findAll({ where: { VideoId: video.id }, order: [['category', 'ASC'], ['order_index', 'ASC']] });
    res.render('popup-question-form', {
      video, parts, question, error: error || null,
      design: question ? parseDesign(question.design) : { ...DEFAULT_DESIGN },
      fontFamilies: FONT_FAMILIES,
    });
  }

  app.get('/admin/popup-questions/video/:videoId', adminGuard, async (req, res) => {
    try {
      const video = await Video.findByPk(req.params.videoId);
      if (!video) return res.status(404).send('❌ غير موجود');
      const questions = await PopupQuestion.findAll({ where: { VideoId: video.id }, order: [['VideoPartId', 'ASC'], ['trigger_seconds', 'ASC'], ['id', 'ASC']] });
      const parts = await VideoPart.findAll({ where: { VideoId: video.id } });
      const partById = new Map(parts.map((p) => [p.id, p]));
      const counts = {};
      if (questions.length) {
        const answers = await PopupQuestionAnswer.findAll({
          where: { PopupQuestionId: questions.map((q) => q.id) },
          attributes: ['PopupQuestionId', 'status'],
        });
        answers.forEach((a) => {
          const c = counts[a.PopupQuestionId] || (counts[a.PopupQuestionId] = { total: 0, pending: 0 });
          c.total += 1;
          if (a.status === 'pending') c.pending += 1;
        });
      }
      res.render('popup-questions', { video, questions, partById, counts });
    } catch (error) {
      console.error('Popup questions list failed:', error);
      res.status(500).send('❌ حصلت مشكلة: ' + error.message);
    }
  });

  app.get('/admin/popup-questions/video/:videoId/new', adminGuard, async (req, res) => {
    const video = await Video.findByPk(req.params.videoId);
    if (!video) return res.status(404).send('❌ غير موجود');
    await renderForm(res, video, null);
  });

  app.post('/admin/popup-questions/video/:videoId', adminGuard, adImageUpload.single('question_image'), async (req, res) => {
    try {
      const video = await Video.findByPk(req.params.videoId);
      if (!video) return res.status(404).send('❌ غير موجود');
      const fields = readQuestionBody(req.body);
      const part = await VideoPart.findOne({ where: { id: Number.parseInt(req.body.VideoPartId, 10) || 0, VideoId: video.id } });
      const error = !part ? 'اختار الفيديو اللي السؤال هيظهر فيه' : validateQuestionFields(fields);
      if (error) return renderForm(res, video, { ...fields, id: null }, error);
      if (req.file) fields.question_image_url = (await uploadBufferToCloudinary(req.file.buffer, 'studyisfunny/popup-questions')).secure_url;
      await PopupQuestion.create({ ...fields, VideoId: video.id, VideoPartId: part.id });
      res.redirect('/admin/popup-questions/video/' + video.id);
    } catch (error) {
      console.error('Popup question create failed:', error);
      res.status(500).send('❌ حصلت مشكلة: ' + error.message);
    }
  });

  app.get('/admin/popup-questions/:id/edit', adminGuard, async (req, res) => {
    const question = await PopupQuestion.findByPk(req.params.id);
    if (!question) return res.status(404).send('❌ غير موجود');
    const video = await Video.findByPk(question.VideoId);
    await renderForm(res, video, question);
  });

  app.post('/admin/popup-questions/:id/update', adminGuard, adImageUpload.single('question_image'), async (req, res) => {
    try {
      const question = await PopupQuestion.findByPk(req.params.id);
      if (!question) return res.status(404).send('❌ غير موجود');
      const video = await Video.findByPk(question.VideoId);
      const fields = readQuestionBody(req.body);
      const part = await VideoPart.findOne({ where: { id: Number.parseInt(req.body.VideoPartId, 10) || 0, VideoId: question.VideoId } });
      const error = !part ? 'اختار الفيديو اللي السؤال هيظهر فيه' : validateQuestionFields(fields);
      if (error) return renderForm(res, video, Object.assign(question, fields), error);
      if (req.file) fields.question_image_url = (await uploadBufferToCloudinary(req.file.buffer, 'studyisfunny/popup-questions')).secure_url;
      else if (req.body.remove_image === '1') fields.question_image_url = null;
      await question.update({ ...fields, VideoPartId: part.id });
      res.redirect('/admin/popup-questions/video/' + question.VideoId);
    } catch (error) {
      console.error('Popup question update failed:', error);
      res.status(500).send('❌ حصلت مشكلة: ' + error.message);
    }
  });

  app.post('/admin/popup-questions/:id/toggle', adminGuard, async (req, res) => {
    const question = await PopupQuestion.findByPk(req.params.id);
    if (!question) return res.status(404).send('❌ غير موجود');
    await question.update({ is_active: !question.is_active });
    res.redirect('/admin/popup-questions/video/' + question.VideoId);
  });

  app.post('/admin/popup-questions/:id/delete', adminGuard, async (req, res) => {
    const question = await PopupQuestion.findByPk(req.params.id);
    if (!question) return res.status(404).send('❌ غير موجود');
    // إجابات الطلاب ونقاطهم اللي اتمنحت بتفضل زي ما هي؛ بنمسح السؤال وإجاباته من الجدول بس
    await PopupQuestionAnswer.destroy({ where: { PopupQuestionId: question.id } });
    await question.destroy();
    res.redirect('/admin/popup-questions/video/' + question.VideoId);
  });

  app.get('/admin/popup-questions/:id/stats', adminGuard, async (req, res) => {
    try {
      const question = await PopupQuestion.findByPk(req.params.id);
      if (!question) return res.status(404).send('❌ غير موجود');
      const video = await Video.findByPk(question.VideoId);
      const answers = await PopupQuestionAnswer.findAll({ where: { PopupQuestionId: question.id }, order: [['createdAt', 'ASC']] });
      const students = answers.length
        ? await Student.findAll({ where: { id: answers.map((a) => a.StudentId) }, attributes: ['id', 'name', 'student_code'] })
        : [];
      const studentById = new Map(students.map((s) => [s.id, s]));

      const rows = answers.map((a) => ({
        id: a.id,
        student: studentById.get(a.StudentId) || null,
        selected: a.selected_choice,
        essayImage: a.essay_image_url,
        status: a.status,
        isCorrect: a.is_correct,
        points: a.points_awarded,
        at: a.createdAt,
      }));

      const total = rows.length;
      const graded = rows.filter((r) => r.isCorrect !== null);
      const correct = graded.filter((r) => r.isCorrect === true).length;
      const wrong = graded.filter((r) => r.isCorrect === false).length;
      const pending = rows.filter((r) => r.isCorrect === null).length;
      const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
      const choiceCounts = {};
      CHOICES.forEach((c) => { choiceCounts[c] = rows.filter((r) => r.selected === c).length; });
      const summary = {
        total, correct, wrong, pending,
        correctPct: pct(correct, graded.length),
        wrongPct: pct(wrong, graded.length),
        choices: CHOICES.map((c) => ({ key: c, count: choiceCounts[c], pct: pct(choiceCounts[c], total) })),
      };
      res.render('popup-question-stats', { video, question, rows, summary });
    } catch (error) {
      console.error('Popup question stats failed:', error);
      res.status(500).send('❌ حصلت مشكلة: ' + error.message);
    }
  });

  // تصحيح المقالي: correct | wrong. النقاط بتتمنح مرة واحدة بس، ولو التصحيح اتغير بتتعدل بالفرق.
  app.post('/admin/popup-questions/answers/:answerId/grade', adminGuard, async (req, res) => {
    try {
      const result = req.body.result;
      if (!['correct', 'wrong'].includes(result)) return res.status(400).send('❌ قيمة غير صحيحة');
      const answer = await PopupQuestionAnswer.findByPk(req.params.answerId);
      if (!answer) return res.status(404).send('❌ غير موجود');
      const question = await PopupQuestion.findByPk(answer.PopupQuestionId);
      if (!question) return res.status(404).send('❌ غير موجود');

      const isCorrect = result === 'correct';
      const target = isCorrect ? question.bonus_points : 0;
      const delta = target - answer.points_awarded;
      // الشرط على points_awarded بيمنع التصحيح المزدوج (ضغطتين) من إنه يمنح النقاط مرتين
      const [updated] = await PopupQuestionAnswer.update(
        { is_correct: isCorrect, status: 'graded', points_awarded: target, graded_by: req.session.userId || null, graded_at: new Date() },
        { where: { id: answer.id, points_awarded: answer.points_awarded } }
      );
      if (updated && delta !== 0) {
        await addPoints(answer.StudentId, delta, delta > 0 ? 'سؤال منبثق (مقالي) صحيح' : 'تعديل تصحيح سؤال منبثق', req.session.userId || null);
      }
      res.redirect('/admin/popup-questions/' + question.id + '/stats');
    } catch (error) {
      console.error('Popup essay grading failed:', error);
      res.status(500).send('❌ حصلت مشكلة: ' + error.message);
    }
  });

  // ================= الطالب =================

  // نفس شرط الربط بالمادة/السنتر اللي في endpoint الأجزاء (بدون شرط المشاهدات)
  async function studentMatchesVideo(student, videoId) {
    if (hasAllVideoAccess(student)) return true;
    const video = await Video.findOne({
      where: { id: videoId },
      include: [
        { model: Session, required: false },
        { model: VideoSession, required: false, include: [{ model: Session }] },
      ],
    });
    if (!video) return false;
    const linked = [video.Session, ...(video.VideoSessions || []).map((vs) => vs.Session)]
      .filter((s) => s && s.SubjectId === student.SubjectId && s.CenterId === student.CenterId);
    if (linked.length > 0) return true;
    return !!(await VideoStudentAccess.findOne({ where: { VideoId: video.id, StudentId: student.id } }));
  }

  function studentQuestionPayload(q, answer) {
    const payload = {
      id: q.id,
      videoPartId: q.VideoPartId,
      type: q.question_type,
      triggerType: q.trigger_type,
      triggerSeconds: q.trigger_seconds,
      text: q.question_text,
      imageUrl: q.question_image_url,
      choices: q.question_type === 'mcq' ? { a: q.choice_a, b: q.choice_b, c: q.choice_c, d: q.choice_d } : null,
      bonusPoints: q.bonus_points,
      design: parseDesign(q.design),
      answered: !!answer,
    };
    if (answer) payload.result = answerResultPayload(q, answer);
    return payload;
  }

  function answerResultPayload(q, answer) {
    return {
      status: answer.status,
      selected: answer.selected_choice,
      isCorrect: answer.is_correct,
      pointsAwarded: answer.points_awarded,
      correctChoice: q.question_type === 'mcq' ? q.correct_choice : null,
      solution: solutionPayload(q),
    };
  }

  app.get('/api/portal/student/lessons/:videoId/popups', verifyPortalToken('student'), async (req, res) => {
    try {
      const student = await Student.findByPk(req.portalStudentId);
      if (!student) return res.status(404).json({ success: false });
      const videoId = Number.parseInt(req.params.videoId, 10);
      if (!Number.isInteger(videoId) || !(await studentMatchesVideo(student, videoId))) return res.json({ success: true, questions: [] });

      const questions = await PopupQuestion.findAll({ where: { VideoId: videoId, is_active: true }, order: [['trigger_seconds', 'ASC'], ['id', 'ASC']] });
      const answers = questions.length
        ? await PopupQuestionAnswer.findAll({ where: { StudentId: student.id, PopupQuestionId: questions.map((q) => q.id) } })
        : [];
      const answerByQ = new Map(answers.map((a) => [a.PopupQuestionId, a]));
      res.json({ success: true, questions: questions.map((q) => studentQuestionPayload(q, answerByQ.get(q.id))) });
    } catch (error) {
      console.error('Popup questions fetch failed:', error);
      res.status(500).json({ success: false });
    }
  });

  async function recordAnswer(req, res, build) {
    try {
      const student = await Student.findByPk(req.portalStudentId);
      if (!student) return res.status(404).json({ success: false });
      const question = await PopupQuestion.findOne({ where: { id: Number.parseInt(req.params.id, 10) || 0, is_active: true } });
      if (!question || !(await studentMatchesVideo(student, question.VideoId))) return res.status(404).json({ success: false, message: 'السؤال غير موجود' });

      const existing = await PopupQuestionAnswer.findOne({ where: { PopupQuestionId: question.id, StudentId: student.id } });
      if (existing) return res.json({ success: true, alreadyAnswered: true, result: answerResultPayload(question, existing) });

      const built = await build(question);
      if (built.error) return res.status(400).json({ success: false, message: built.error });

      let answer;
      try {
        answer = await PopupQuestionAnswer.create({ ...built.fields, PopupQuestionId: question.id, StudentId: student.id });
      } catch (error) {
        // ضغطتين/طلبين متزامنين: الـ unique index بيمنع التكرار، نرجّع الإجابة الأولى
        if (error.name === 'SequelizeUniqueConstraintError') {
          const first = await PopupQuestionAnswer.findOne({ where: { PopupQuestionId: question.id, StudentId: student.id } });
          if (first) return res.json({ success: true, alreadyAnswered: true, result: answerResultPayload(question, first) });
        }
        throw error;
      }
      if (answer.points_awarded > 0) {
        await addPoints(student.id, answer.points_awarded, 'سؤال منبثق صحيح', null);
      }
      res.json({ success: true, result: answerResultPayload(question, answer) });
    } catch (error) {
      console.error('Popup answer failed:', error);
      res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
    }
  }

  app.post('/api/portal/student/popup-questions/:id/answer', verifyPortalToken('student'), (req, res) =>
    recordAnswer(req, res, async (question) => {
      if (question.question_type !== 'mcq') return { error: 'السؤال ده مقالي' };
      const choice = String(req.body?.choice || '').toLowerCase();
      if (!CHOICES.includes(choice)) return { error: 'اختيار غير صحيح' };
      const isCorrect = choice === question.correct_choice;
      return {
        fields: {
          selected_choice: choice, status: 'answered', is_correct: isCorrect,
          points_awarded: isCorrect ? question.bonus_points : 0,
        },
      };
    }));

  app.post('/api/portal/student/popup-questions/:id/essay', verifyPortalToken('student'), essayUpload.single('image'), (req, res) =>
    recordAnswer(req, res, async (question) => {
      if (question.question_type !== 'essay') return { error: 'السؤال ده اختياري' };
      if (!req.file) return { error: 'ارفع صورة الإجابة' };
      const uploaded = await uploadBufferToCloudinary(req.file.buffer, 'studyisfunny/popup-essays');
      return { fields: { essay_image_url: uploaded.secure_url, status: 'pending', is_correct: null, points_awarded: 0 } };
    }));

  // نتائج الطالب مجمعة حسب الدرس (بتتعرض على كروت lessons.html)
  app.get('/api/portal/student/popup-results', verifyPortalToken('student'), async (req, res) => {
    try {
      const answers = await PopupQuestionAnswer.findAll({ where: { StudentId: req.portalStudentId } });
      if (!answers.length) return res.json({ success: true, results: {} });
      const questions = await PopupQuestion.findAll({ where: { id: answers.map((a) => a.PopupQuestionId) } });
      const questionById = new Map(questions.map((q) => [q.id, q]));
      const results = {};
      answers.forEach((a) => {
        const q = questionById.get(a.PopupQuestionId);
        if (!q) return;
        (results[q.VideoId] || (results[q.VideoId] = [])).push({
          questionId: q.id,
          type: q.question_type,
          title: q.title || null,
          status: a.status,
          isCorrect: a.is_correct,
          points: a.points_awarded,
        });
      });
      res.json({ success: true, results });
    } catch (error) {
      console.error('Popup results failed:', error);
      res.status(500).json({ success: false });
    }
  });
};
