require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const sequelize = require('./config/database');
const { Op } = require('sequelize');
const https = require('https');
const fs = require('fs');
const qrcodeTerminal = require('qrcode-terminal');
const getLocalIP = require('./utils/getLocalIP');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const PERMISSIONS_LIST = require('./permissions');
const cron = require('node-cron');
const { exec } = require('child_process');
const compression = require('compression');

// استدعاء الجداول
const Center = require('./models/Center');
const Subject = require('./models/Subject');
const Student = require('./models/Student');
const QRCode = require('qrcode');
const CenterSubjectSeries = require('./models/CenterSubjectSeries');
const Session = require('./models/Session');
const Attendance = require('./models/Attendance');
const HomeworkCheck = require('./models/HomeworkCheck');
const BalanceTransaction = require('./models/BalanceTransaction');
const Exam = require('./models/Exam');
const ExamResult = require('./models/ExamResult');
const User = require('./models/User');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const Video = require('./models/Video');
const VideoPart = require('./models/VideoPart');
const WatchProgress = require('./models/WatchProgress');
const multer = require('multer');
const VideoAccessGrant = require('./models/VideoAccessGrant');
const Warning = require('./models/Warning');

require('./models/associations')();

// ✅ لازم نعرف app الأول قبل ما نستخدمه في أي route
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors()); // يسمح لأي موقع يتواصل مع الـ API بتاعنا
app.use(compression());

// Middleware عشان السيرفر يقدر يقرا بيانات الفورمز
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// عشان نقدر نستخدم ملفات CSS / JS / صور من فولدر public
app.use(express.static(path.join(__dirname, 'public')));

// تجهيز رفع الفيديوهات وحفظها في فولدر public/uploads/videos
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads', 'videos');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  },
});
const videoUpload = multer({ storage: videoStorage, limits: { fileSize: 500 * 1024 * 1024 } }); // حد أقصى 500 ميجا

// إعداد نظام الجلسات (تسجيل الدخول)
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

// إعداد محرك الصفحات EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// صفحة تجريبية للتأكد إن السيرفر شغال
app.get('/', (req, res) => {
  res.send('<h1>السيستم شغال تمام! 🎉</h1>');
});

// ===== Routes بتاعة تسجيل الدخول =====

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await User.findOne({ where: { username } });
    if (!user) {
      return res.render('login', { error: 'اليوزرنيم أو الباسورد غلط' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.render('login', { error: 'اليوزرنيم أو الباسورد غلط' });
    }

    // تخزين بيانات المستخدم في الجلسة
    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userRole = user.role;

    res.redirect('/sessions');
  } catch (error) {
    console.error(error);
    res.render('login', { error: 'حصلت مشكلة، جرب تاني' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// إتاحة بيانات المستخدم تلقائيًا في كل صفحة EJS
app.use((req, res, next) => {
  res.locals.userName = req.session.userName;
  res.locals.userRole = req.session.userRole;
  next();
});
// ===== Middleware الحماية =====
// أي صفحة بعد السطر ده هتكون محمية - لازم تسجيل دخول الأول
function requireLogin(req, res, next) {
  // مسارات API بتاعة بوابة الطالب/ولي الأمر مستقلة تمامًا، ومحمية بـ Token بدل الجلسة
  if (req.path.startsWith('/api/portal')) {
    return next();
  }
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

app.use(requireLogin);

// حماية إضافية لصفحات الأدمن بس
function requireAdmin(req, res, next) {
  if (req.session.userRole !== 'admin') {
    return res.status(403).send('⛔ هذه الصفحة للأدمن فقط');
  }
  next();
}

function requireClosingAuth(req, res, next) {
  if (req.session.userRole !== 'admin') return res.status(403).send('⛔ للأدمن فقط');
  if (req.session.closingUnlocked) return next();
  res.redirect('/admin/closing/lock');
}

app.get('/admin/closing/lock', requireAdmin, (req, res) => res.render('closing-lock', { error: null }));

app.post('/admin/closing/unlock', requireAdmin, async (req, res) => {
  const adminUser = await User.findByPk(req.session.userId);
  const match = await bcrypt.compare(req.body.password, adminUser.password);
  if (!match) return res.render('closing-lock', { error: 'كلمة المرور غير صحيحة' });
  req.session.closingUnlocked = true;
  res.redirect('/admin/closing');
});

app.post('/admin/closing/lock-again', requireAdmin, (req, res) => {
  req.session.closingUnlocked = false;
  res.redirect('/dashboard');
});

// تحميل صلاحيات المستخدم في الجلسة عند كل طلب (يضمن التحديث الفوري لو الأدمن غيّرها)
app.use(async (req, res, next) => {
  if (req.session.userId && req.session.userRole === 'assistant') {
    const user = await User.findByPk(req.session.userId);
    req.session.userPermissions = user.permissions ? JSON.parse(user.permissions) : [];
  }
  next();
});

function requirePermission(key) {
  return (req, res, next) => {
    if (req.session.userRole === 'admin') return next();
    const perms = req.session.userPermissions || [];
    if (!perms.includes(key)) {
      return res.status(403).send('⛔ لا تملك صلاحية الوصول لهذه الصفحة');
    }
    next();
  };
}

function requirePermissionOrAdmin(key) {
  return (req, res, next) => {
    if (req.session.userRole === 'admin') return next();
    const perms = req.session.userPermissions || [];
    if (!perms.includes(key)) return res.status(403).send('⛔ لا تملك صلاحية الوصول');
    next();
  };
}

// إتاحة الصلاحيات وقائمتها لكل صفحة EJS (للسايد بار)
app.use((req, res, next) => {
  res.locals.userPermissions = req.session.userPermissions || [];
  res.locals.PERMISSIONS_LIST = PERMISSIONS_LIST;
  next();
});

// ===== Routes بتاعة الطلاب =====

app.get('/students', requirePermission('students_view'), async (req, res) => {
  const { search, center_id, subject_id } = req.query;

  const where = {};
  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { student_code: { [Op.like]: `%${search}%` } },
      { phone: { [Op.like]: `%${search}%` } },
    ];
  }
  if (center_id) where.CenterId = center_id;
  if (subject_id) where.SubjectId = subject_id;

  const students = await Student.findAll({
    where,
    include: [Center, Subject],
    order: [['createdAt', 'DESC']],
  });

  const centers = await Center.findAll();
  const subjects = await Subject.findAll();

  res.render('students-list', {
    students,
    centers,
    subjects,
    filters: { search: search || '', center_id: center_id || '', subject_id: subject_id || '' },
  });
});

app.get('/students/new', requirePermission('students_add'), async (req, res) => {
  const centers = await Center.findAll();
  const subjects = await Subject.findAll();
  res.render('add-student', { centers, subjects });
});

// تصدير قائمة الطلاب (بنفس الفلتر المطبق) إلى إكسيل
app.get('/students/export', async (req, res) => {
  try {
    const { search, center_id, subject_id } = req.query;

    const where = {};
    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { student_code: { [Op.like]: `%${search}%` } },
        { phone: { [Op.like]: `%${search}%` } },
      ];
    }
    if (center_id) where.CenterId = center_id;
    if (subject_id) where.SubjectId = subject_id;

    const students = await Student.findAll({
      where,
      include: [Center, Subject],
      order: [['name', 'ASC']],
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('الطلاب');

    sheet.columns = [
      { header: 'الكود', key: 'code', width: 15 },
      { header: 'الاسم', key: 'name', width: 25 },
      { header: 'تليفون الطالب', key: 'phone', width: 18 },
      { header: 'تليفون ولي الأمر', key: 'parent_phone', width: 18 },
      { header: 'المادة', key: 'subject', width: 20 },
      { header: 'السنتر', key: 'center', width: 20 },
      { header: 'سعر الحصة', key: 'price', width: 12 },
      { header: 'الرصيد', key: 'balance', width: 12 },
      { header: 'البوكليت', key: 'booklet', width: 12 },
    ];

    students.forEach(s => {
      sheet.addRow({
        code: s.student_code,
        name: s.name,
        phone: s.phone,
        parent_phone: s.parent_phone,
        subject: s.Subject ? s.Subject.name : '-',
        center: s.Center ? s.Center.name : '-',
        price: s.price_per_session,
        balance: s.balance,
        booklet: s.booklet_status ? 'تم الشراء' : 'لسه',
      });
    });

    sheet.getRow(1).font = { bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=students.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// عرض بروفايل طالب واحد بالتفصيل

app.get('/students/:id', async (req, res) => {
  try {
    const student = await Student.findOne({
      where: { id: req.params.id },
      include: [Center, Subject],
    });

    if (!student) return res.status(404).send('❌ الطالب غير موجود');

    const centers = await Center.findAll();
    const subjects = await Subject.findAll();

    // فقط حصص مجموعة الطالب بتاعته (سنتره + مادته)
    const ownSessions = await Session.findAll({
      where: { CenterId: student.CenterId, SubjectId: student.SubjectId },
      include: [Center, Subject],
      order: [['lesson_number', 'ASC']],
    });

    // كل سجلات حضور الطالب
    const attendanceRecords = await Attendance.findAll({
      where: { StudentId: student.id },
      include: [{ model: Session, include: [Center] }, User],
    });

    const attendanceByLesson = {};
    const attendanceUserByLesson = {};
    const attendanceTimeByLesson = {};
    const attendanceIdByLesson = {};
    attendanceRecords.forEach(a => {
      if (a.Session.SubjectId === student.SubjectId) {
        attendanceByLesson[a.Session.lesson_number] = a.Session;
        attendanceUserByLesson[a.Session.lesson_number] = a.User ? a.User.name : '-';
        attendanceTimeByLesson[a.Session.lesson_number] = a.attended_at;
        attendanceIdByLesson[a.Session.lesson_number] = a.id;
      }
    });

    // سجلات الواجب
    const homeworkRecords = await HomeworkCheck.findAll({
      where: { StudentId: student.id },
      include: [{ model: Session, include: [Center] }, User],
    });
    const homeworkByLesson = {};
    const homeworkUserByLesson = {};
    const homeworkTimeByLesson = {};
    homeworkRecords.forEach(h => {
      if (h.Session.SubjectId === student.SubjectId) {
        homeworkByLesson[h.Session.lesson_number] = h.status;
        homeworkUserByLesson[h.Session.lesson_number] = h.User ? h.User.name : '-';
        homeworkTimeByLesson[h.Session.lesson_number] = h.createdAt;
      }
    });

    // ✅ سجلات الامتحانات - لازم تكون هنا، قبل استخدامها تحت
    const examResults = await ExamResult.findAll({
      where: { StudentId: student.id },
      include: [{ model: Exam, include: [Session] }, User],
      order: [['createdAt', 'DESC']],
    });
    
    const examScoreByLesson = {};
    examResults.forEach(r => {
      if (r.Exam.Session) {
        examScoreByLesson[r.Exam.Session.lesson_number] = {
          score: r.score,
          max_score: r.Exam.max_score,
          examName: r.Exam.name,
          recordedBy: r.User ? r.User.name : '-',
          recordedAt: r.createdAt,
        };
      }
    });

    // ✅ دلوقتي نبني attendanceRows - بعد ما كل الـ Maps الثلاثة بقت جاهزة
    const lessonNumbersSet = new Set();
    ownSessions.forEach(s => lessonNumbersSet.add(s.lesson_number));
    Object.keys(attendanceByLesson).forEach(n => lessonNumbersSet.add(parseInt(n)));

    const lessonNumbers = Array.from(lessonNumbersSet).sort((a, b) => a - b);

    const ownSessionByLesson = {};
    ownSessions.forEach(s => { ownSessionByLesson[s.lesson_number] = s; });

    const attendanceRows = lessonNumbers.map(lessonNumber => {
      const ownSession = ownSessionByLesson[lessonNumber];
      const attendedSession = attendanceByLesson[lessonNumber];
      let attendanceStatus, attendedElsewhere = null;

      if (attendedSession) {
        if (ownSession && attendedSession.CenterId === ownSession.CenterId) {
          attendanceStatus = 'attended';
        } else {
          attendanceStatus = 'attended_elsewhere';
          attendedElsewhere = attendedSession.Center.name;
        }
      } else if (ownSession && ownSession.status === 'cancelled') {
        attendanceStatus = 'cancelled';
      } else {
        attendanceStatus = 'absent';
      }

      return {
        session: ownSession || { lesson_number: lessonNumber, serial_number: attendedSession ? attendedSession.serial_number : '-', session_date: attendedSession ? attendedSession.session_date : null },
        attendanceStatus,
        attendedElsewhere,
        attendanceUser: attendanceUserByLesson[lessonNumber] || null,
        attendanceTime: attendanceTimeByLesson[lessonNumber] || null,
        attendanceId: attendanceIdByLesson[lessonNumber] || null,
        homeworkStatus: homeworkByLesson[lessonNumber] || null,
        homeworkUser: homeworkUserByLesson[lessonNumber] || null,
        homeworkTime: homeworkTimeByLesson[lessonNumber] || null,
        examInfo: examScoreByLesson[lessonNumber] || null,
      };
    });

    const transactions = await BalanceTransaction.findAll({
      where: { StudentId: student.id },
      order: [['createdAt', 'DESC']],
    });

    const warnings = await Warning.findAll({
      where: { StudentId: student.id },
      include: [User],
      order: [['createdAt', 'ASC']],
    });

    // بيانات مشاهدة الفيديوهات الخاصة بمادة الطالب
    const studentVideos = await Video.findAll({
      where: { SubjectId: student.SubjectId },
      include: [{ model: Session, include: [Center] }, VideoPart],
      order: [['createdAt', 'ASC']],
    });

    const watchRecords = await WatchProgress.findAll({ where: { StudentId: student.id } });
    const watchMap = {};
    watchRecords.forEach(w => { watchMap[w.VideoPartId] = w.watched_seconds; });

    const categoryLabels = { explanation: 'شرح', questions: 'أسئلة', homework_solution: 'حل واجب' };

    const videoWatchData = studentVideos.map(v => ({
      title: v.title,
      lessonNumber: v.Session ? v.Session.lesson_number : null,
      centerName: v.Session ? v.Session.Center.name : null,
      parts: v.VideoParts.map(p => ({
        category: categoryLabels[p.category] || p.category,
        orderIndex: p.order_index,
        watchedSeconds: watchMap[p.id] || 0,
        durationSeconds: p.duration_seconds,
      })),
    }));

    res.render('student-profile', {
      student,
      centers,
      subjects,
      attendanceRows,
      transactions,
      examResults: examResults.filter(r => !r.Exam.Session),
      videoWatchData,
      warnings,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// إضافة أو خصم رصيد يدوي
app.post('/students/:id/balance', async (req, res) => {
  try {
    const { amount, type, reason } = req.body;
    const student = await Student.findByPk(req.params.id);

    const signedAmount = type === 'deduct' ? -Math.abs(amount) : Math.abs(amount);

    student.balance += parseFloat(signedAmount);
    await student.save();

    await BalanceTransaction.create({
      StudentId: student.id,
      amount: signedAmount,
      reason,
      UserId: req.session.userId,
    });

    res.redirect('/students/' + req.params.id);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

app.post('/students', async (req, res) => {
  try {
    const { name, phone, parent_phone, price_per_session, balance, booklet_status, center_id, subject_id } = req.body;

    const student = await Student.create({
      name,
      phone,
      parent_phone,
      price_per_session,
      balance: balance || 0,
      booklet_status: booklet_status === 'on',
      CenterId: center_id,
      SubjectId: subject_id,
      UserId: req.session.userId,
    });

    const qrCodeImage = await QRCode.toDataURL(student.student_code);

    res.render('student-created', { student, qrCodeImage });
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة في الحفظ: ' + error.message);
  }
});

// ===== Routes بتاعة الحصص =====

app.get('/sessions/new', requirePermission('sessions_create'), async (req, res) => {
  const centers = await Center.findAll();
  const subjects = await Subject.findAll();
  res.render('start-session', { centers, subjects });
});

app.post('/sessions', async (req, res) => {
  try {
    const { subject_id, center_id, mode, lesson_number } = req.body;

    const series = await CenterSubjectSeries.findOne({
      where: { CenterId: center_id, SubjectId: subject_id },
    });

    if (!series) {
      return res.status(400).send('❌ مفيش أساس سيريال معرّف لهذا السنتر والمادة');
    }

    let finalLessonNumber;

    if (mode === 'new') {
      const lastSession = await Session.findOne({
        where: { SubjectId: subject_id },
        order: [['lesson_number', 'DESC']],
      });
      finalLessonNumber = lastSession ? lastSession.lesson_number + 1 : 1;
    } else {
      finalLessonNumber = parseInt(lesson_number);
      if (!finalLessonNumber || finalLessonNumber < 1) {
        return res.status(400).send('❌ لازم تكتب رقم حصة صحيح');
      }
    }

    const serialNumber = series.base_number + finalLessonNumber;

    const newSession = await Session.create({
      lesson_number: finalLessonNumber,
      serial_number: serialNumber,
      CenterId: center_id,
      SubjectId: subject_id,
    });

    const fullSession = await Session.findOne({
      where: { id: newSession.id },
      include: [Center, Subject],
    });

    // تخزين رقم الحصة الشغالة في جلسة الأسيستانت
    req.session.activeSessionId = newSession.id;

    res.render('session-started', { session: fullSession });
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// عرض كل الحصص + اختيار الشغالة
app.get('/sessions', requirePermission('sessions_view'), async (req, res) => {
  const sessions = await Session.findAll({
    include: [Center, Subject],
    order: [['createdAt', 'DESC']],
    limit: 100,
  });
  res.render('sessions-list', { sessions, activeSessionId: req.session.activeSessionId });
});

// تفعيل حصة موجودة كـ "الشغالة دلوقتي"
app.post('/sessions/:id/activate', (req, res) => {
  req.session.activeSessionId = req.params.id;
  res.redirect('/sessions');
});

// تبديل سريع للحصة الشغالة (خاص بجهاز المستخدم بس) من أي صفحة
app.post('/sessions/switch', (req, res) => {
  req.session.activeSessionId = req.body.session_id;
  res.redirect(req.body.redirect_to || '/sessions');
});

// تقرير الحصة: الحاضرين والغايبين بالتفصيل
app.get('/sessions/:id/report', async (req, res) => {
  try {
    const session = await Session.findOne({
      where: { id: req.params.id },
      include: [Center, Subject],
    });
    if (!session) return res.status(404).send('❌ الحصة غير موجودة');

    const attendances = await Attendance.findAll({
      where: { SessionId: session.id },
      include: [{ model: Student }, User],
    });

    const homeworkRecords = await HomeworkCheck.findAll({
      where: { SessionId: session.id },
      include: [User],
    });
    const homeworkMap = {};
    homeworkRecords.forEach(h => {
      homeworkMap[h.StudentId] = { status: h.status, user: h.User ? h.User.name : '-', time: h.createdAt };
    });

    const linkedExam = await Exam.findOne({ where: { SessionId: session.id } });
    const examMap = {};
    if (linkedExam) {
      const examResults = await ExamResult.findAll({
        where: { ExamId: linkedExam.id },
        include: [User],
      });
      examResults.forEach(r => {
        examMap[r.StudentId] = { score: r.score, max: linkedExam.max_score, user: r.User ? r.User.name : '-', time: r.createdAt };
      });
    }

    const attendedRows = attendances.map(a => {
      const hw = homeworkMap[a.StudentId];
      const exam = examMap[a.StudentId];
      return {
        attendanceId: a.id,
        student: a.Student,
        attendanceUser: a.User ? a.User.name : '-',
        attendanceTime: a.attended_at,
        comment: a.comment,
        payment: a.payment_collected,
        homeworkStatus: hw ? hw.status : null,
        homeworkUser: hw ? hw.user : null,
        homeworkTime: hw ? hw.time : null,
        examScore: exam ? exam.score : null,
        examMax: exam ? exam.max : null,
        examUser: exam ? exam.user : null,
        examTime: exam ? exam.time : null,
      };
    });

    let absentStudents = [];
    if (session.status !== 'cancelled') {
      const groupStudents = await Student.findAll({
        where: { CenterId: session.CenterId, SubjectId: session.SubjectId },
      });

      const attendedAnywhere = await Attendance.findAll({
        include: [{
          model: Session,
          where: { lesson_number: session.lesson_number, SubjectId: session.SubjectId },
        }],
      });
      const attendedStudentIds = new Set(attendedAnywhere.map(a => a.StudentId));

      absentStudents = groupStudents.filter(s => !attendedStudentIds.has(s.id));
    }

    const subject = await Subject.findByPk(session.SubjectId);
    let normalCount = 0, reducedCount = 0, freeCount = 0, totalRevenue = 0;

    for (const a of attendances) {
      const st = await Student.findByPk(a.StudentId);
      totalRevenue += st.price_per_session;
      if (st.price_per_session === 0) freeCount++;
      else if (st.price_per_session >= subject.default_price) normalCount++;
      else reducedCount++;
    }

    const totalCost = (session.cost_per_normal || 0) * normalCount + (session.cost_per_reduced || 0) * reducedCount;
    const totalCashCollected = attendances.reduce((sum, a) => sum + (a.payment_collected || 0), 0);

    res.render('session-report', {
      session, attendedRows, absentStudents,
      closing: { normalCount, reducedCount, freeCount, totalRevenue, totalCost },
      totalCashCollected,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// تصدير الحاضرين في حصة معينة إلى إكسيل
app.get('/sessions/:id/report/export-attendance', async (req, res) => {
  try {
    const session = await Session.findOne({
      where: { id: req.params.id },
      include: [Center, Subject],
    });
    if (!session) return res.status(404).send('❌ الحصة غير موجودة');

    const attendances = await Attendance.findAll({
      where: { SessionId: session.id },
      include: [Student, User],
    });

    const homeworkRecords = await HomeworkCheck.findAll({ where: { SessionId: session.id } });
    const homeworkMap = {};
    homeworkRecords.forEach(h => { homeworkMap[h.StudentId] = h.status; });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('الحاضرين');

    sheet.columns = [
      { header: 'الكود', key: 'code', width: 15 },
      { header: 'الاسم', key: 'name', width: 25 },
      { header: 'تليفون الطالب', key: 'phone', width: 18 },
      { header: 'تليفون ولي الأمر', key: 'parent_phone', width: 18 },
      { header: 'الواجب', key: 'homework', width: 15 },
      { header: 'كومنت', key: 'comment', width: 25 },
      { header: 'دفع وقت الحضور', key: 'payment', width: 15 },
      { header: 'سجّل الحضور', key: 'user', width: 18 },
    ];

    const homeworkLabels = {
      complete: 'كامل', incomplete: 'مش كامل', no_steps: 'من غير خطوات', not_done: 'مش معمول',
    };

    attendances.forEach(a => {
      sheet.addRow({
        code: a.Student.student_code,
        name: a.Student.name,
        phone: a.Student.phone,
        parent_phone: a.Student.parent_phone,
        homework: homeworkLabels[homeworkMap[a.StudentId]] || '-',
        comment: a.comment || '-',
        payment: a.payment_collected || 0,
        user: a.User ? a.User.name : '-',
      });
    });

    sheet.getRow(1).font = { bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_session_${session.serial_number}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// تصدير الغايبين في حصة معينة إلى إكسيل
app.get('/sessions/:id/report/export-absent', async (req, res) => {
  try {
    const session = await Session.findOne({
      where: { id: req.params.id },
      include: [Center, Subject],
    });
    if (!session) return res.status(404).send('❌ الحصة غير موجودة');

    let absentStudents = [];
    if (session.status !== 'cancelled') {
      const groupStudents = await Student.findAll({
        where: { CenterId: session.CenterId, SubjectId: session.SubjectId },
      });

      const attendedAnywhere = await Attendance.findAll({
        include: [{
          model: Session,
          where: { lesson_number: session.lesson_number, SubjectId: session.SubjectId },
        }],
      });
      const attendedStudentIds = new Set(attendedAnywhere.map(a => a.StudentId));

      absentStudents = groupStudents.filter(s => !attendedStudentIds.has(s.id));
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('الغايبين');

    sheet.columns = [
      { header: 'الكود', key: 'code', width: 15 },
      { header: 'الاسم', key: 'name', width: 25 },
      { header: 'تليفون الطالب', key: 'phone', width: 18 },
      { header: 'تليفون ولي الأمر', key: 'parent_phone', width: 18 },
      { header: 'الرصيد الحالي', key: 'balance', width: 15 },
    ];

    absentStudents.forEach(s => {
      sheet.addRow({
        code: s.student_code,
        name: s.name,
        phone: s.phone,
        parent_phone: s.parent_phone,
        balance: s.balance,
      });
    });

    sheet.getRow(1).font = { bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=absent_session_${session.serial_number}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// إلغاء حصة (من سنتر واحد أو من كل السناتر)
app.post('/sessions/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const { scope } = req.body;
    const session = await Session.findByPk(req.params.id);
    if (!session) return res.status(404).send('❌ الحصة غير موجودة');

    if (scope === 'all') {
      await Session.update(
        { status: 'cancelled' },
        { where: { lesson_number: session.lesson_number, SubjectId: session.SubjectId } }
      );
    } else {
      session.status = 'cancelled';
      await session.save();
    }

    res.redirect('/sessions');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// استعادة حصة ملغية (تراجع عن الإلغاء)
app.post('/sessions/:id/restore', requireAdmin, async (req, res) => {
  try {
    const session = await Session.findByPk(req.params.id);
    if (!session) return res.status(404).send('❌ الحصة غير موجودة');

    session.status = 'normal';
    await session.save();

    res.redirect('/sessions');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// تعديل بيانات حصة (تاريخها مثلًا، لو اتسجلت غلط)
app.post('/sessions/:id/edit', requireAdmin, async (req, res) => {
  try {
    const { session_date } = req.body;
    await Session.update({ session_date }, { where: { id: req.params.id } });
    res.redirect('/sessions');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});
app.post('/students/:id/edit', async (req, res) => {
  try {
    const { name, phone, parent_phone, price_per_session, booklet_status, center_id, subject_id, admin_note } = req.body;

    await Student.update({
      name,
      phone,
      parent_phone,
      price_per_session,
      booklet_status: booklet_status === 'on',
      CenterId: center_id,
      SubjectId: subject_id,
      admin_note,
    }, { where: { id: req.params.id } });

    res.redirect('/students/' + req.params.id);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// حذف حصة بالكامل (لو اتسجلت غلط تمامًا ومفيش بيانات مهمة مرتبطة بيها)
app.post('/sessions/:id/delete', requireAdmin, async (req, res) => {
  try {
    const sessionId = req.params.id;

    const sessionToDelete = await Session.findOne({ where: { id: sessionId }, include: [Center] });
    if (!sessionToDelete) return res.status(404).send('❌ الحصة غير موجودة');
    if (sessionToDelete.Center.name !== 'أونلاين') {
      return res.status(400).send('❌ الحذف النهائي متاح فقط لحصص الأونلاين. استخدم "إلغاء" لحصص السنتر.');
    }

    // نتأكد الأول إن مفيش حضور أو واجب أو امتحان مسجل عليها - عشان منمسحش بيانات مهمة بالغلط
    const attendanceCount = await Attendance.count({ where: { SessionId: sessionId } });
    const homeworkCount = await HomeworkCheck.count({ where: { SessionId: sessionId } });
    const examCount = await Exam.count({ where: { SessionId: sessionId } });

    if (attendanceCount > 0 || homeworkCount > 0 || examCount > 0) {
      return res.status(400).send('❌ مينفعش تحذف الحصة دي لأن فيها بيانات حضور/واجب/امتحان مسجلة. استخدم "إلغاء" بدلاً من الحذف.');
    }

    await Session.destroy({ where: { id: sessionId } });
    res.redirect('/sessions');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// ===== Routes بتاعة الحضور =====

app.get('/attendance/scan', requirePermission('attendance_scan'), async (req, res) => {
  if (!req.session.activeSessionId) {
    return res.send('⚠️ لازم تبدأ حصة الأول من <a href="/sessions/new">هنا</a>');
  }
  const activeSession = await Session.findOne({
    where: { id: req.session.activeSessionId },
    include: [Center, Subject],
  });
  const recentSessions = await Session.findAll({
    include: [Center, Subject],
    order: [['createdAt', 'DESC']],
    limit: 30,
  });
  const allSubjects = await Subject.findAll();
  const allCenters = await Center.findAll();
  res.render('scan-attendance', {
    activeSession,
    recentSessions,
    currentSessionId: req.session.activeSessionId,
    currentPath: '/attendance/scan',
    allSubjects,
    allCenters,
  });
});

app.post('/students/quick-add', requirePermission('attendance_scan'), async (req, res) => {
  try {
    const { name, phone, parent_phone, price_per_session, center_id, subject_id } = req.body;
    const student = await Student.create({
      name, phone, parent_phone, price_per_session,
      CenterId: center_id, SubjectId: subject_id,
      UserId: req.session.userId,
    });
    const qrCodeImage = await QRCode.toDataURL(student.student_code);
    res.json({ success: true, student, qrCodeImage });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة: ' + error.message });
  }
});

// المرحلة 1: عرض ملخص الطالب قبل تأكيد الحضور
app.post('/attendance/scan/lookup', async (req, res) => {
  try {
    const { student_code } = req.body;
    const sessionId = req.session.activeSessionId;

    const student = await Student.findOne({ where: { student_code }, include: [Center, Subject] });
    if (!student) return res.json({ success: false, message: 'كود الطالب غير صحيح' });

    const activeSession = await Session.findByPk(sessionId);
    if (activeSession.status === 'cancelled') {
      return res.json({ success: false, message: '⚠️ هذه الحصة ملغية' });
    }

    const existing = await Attendance.findOne({ where: { StudentId: student.id, SessionId: sessionId } });
    if (existing) return res.json({ success: false, message: `${student.name} مسجل حضوره من قبل` });

    // الحصص اللي بتاعت مجموعة الطالب الأصلية
    const ownSessions = await Session.findAll({
      where: { CenterId: student.CenterId, SubjectId: student.SubjectId },
      order: [['lesson_number', 'ASC']],
    });

    const attendanceRecords = await Attendance.findAll({
      where: { StudentId: student.id },
      include: [{ model: Session, include: [Center] }],
    });
    const attByLesson = {};
    attendanceRecords.forEach(a => {
      if (a.Session.SubjectId === student.SubjectId) attByLesson[a.Session.lesson_number] = a.Session;
    });

    // نجمع كل أرقام الحصص: من مجموعته + أي حصص حضرها في مكان تاني (زي أونلاين)
    const lessonNumbersSet = new Set();
    ownSessions.forEach(s => lessonNumbersSet.add(s.lesson_number));
    Object.keys(attByLesson).forEach(n => lessonNumbersSet.add(parseInt(n)));
    const lessonNumbers = Array.from(lessonNumbersSet).sort((a, b) => a - b);

    const videos = await Video.findAll({
      where: { SubjectId: student.SubjectId },
      include: [Session, VideoPart],
    });
    const videoBySessionId = {};
    videos.forEach(v => { videoBySessionId[v.SessionId] = v; });

    const watchRecords = await WatchProgress.findAll({ where: { StudentId: student.id } });
    const watchMap = {};
    watchRecords.forEach(w => { watchMap[w.VideoPartId] = w.watched_seconds; });

    const categoryLabels = { explanation: 'شرح', questions: 'أسئلة', homework_solution: 'حل واجب' };

    const summary = lessonNumbers.map(lessonNumber => {
      const att = attByLesson[lessonNumber];
      let parts = [];
      if (att) {
        const video = videoBySessionId[att.id];
        if (video) {
          parts = video.VideoParts.map(p => ({
            category: categoryLabels[p.category] || p.category,
            watchedSeconds: watchMap[p.id] || 0,
            durationSeconds: p.duration_seconds,
          }));
        }
      }
      return {
        lessonNumber,
        attended: !!att,
        attendedWhere: att ? att.Center.name : null,
        parts,
      };
    });

    res.json({
      success: true,
      student: {
        id: student.id,
        name: student.name,
        code: student.student_code,
        balance: student.balance,
        priceperSession: student.price_per_session,
        adminNote: student.admin_note,
      },
      summary,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

app.post('/attendance/scan', async (req, res) => {
  try {
    const { student_code, comment, payment_collected } = req.body;
    const sessionId = req.session.activeSessionId;

    if (!sessionId) {
      return res.json({ success: false, message: 'مفيش حصة شغالة دلوقتي' });
    }

    const student = await Student.findOne({ where: { student_code } });
    if (!student) {
      return res.json({ success: false, message: 'كود الطالب غير صحيح' });
    }

    const activeSession = await Session.findByPk(sessionId);
    if (activeSession.status === 'cancelled') {
      return res.json({ success: false, message: '⚠️ هذه الحصة ملغية، لا يمكن تسجيل حضور فيها' });
    }

    if (student.is_blocked) {
      return res.json({ success: false, message: `⛔ الطالب ${student.name} محظور من النظام. تواصل مع الأدمن.` });
    }

    const existingAttendance = await Attendance.findOne({
      where: { StudentId: student.id, SessionId: sessionId },
    });

    if (existingAttendance) {
      return res.json({
        success: false,
        message: `الطالب ${student.name} مسجل حضوره في هذه الحصة من قبل`,
      });
    }

    const paymentAmount = parseFloat(payment_collected) || 0;

    // لو فيه مبلغ مدفوع وقت الحضور، يتضاف للرصيد ويتسجل في سجل المعاملات
    if (paymentAmount > 0) {
      student.balance += paymentAmount;
      await BalanceTransaction.create({
        StudentId: student.id,
        amount: paymentAmount,
        reason: 'دفع نقدي وقت الحضور',
        UserId: req.session.userId,
      });
    }

    if (student.balance < student.price_per_session) {
      return res.json({
        success: false,
        message: `رصيد الطالب ${student.name} غير كافٍ (الرصيد الحالي: ${student.balance} ج)`,
      });
    }

    student.balance -= student.price_per_session;
    await student.save();

    await Attendance.create({
      StudentId: student.id,
      SessionId: sessionId,
      UserId: req.session.userId,
      comment: comment || null,
      payment_collected: paymentAmount,
    });

    await addPoints(student.id, 2);

    res.json({
      success: true,
      message: 'تم تسجيل الحضور والخصم بنجاح',
      student_name: student.name,
      remaining_balance: student.balance,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

// خاصية أدمن خاصة: تسجيل حضور رغم نقص الرصيد (يخلي الرصيد بالسالب) - تتطلب تأكيد الباسورد
app.post('/attendance/scan/force', async (req, res) => {
  try {
    if (req.session.userRole !== 'admin') {
      return res.status(403).json({ success: false, message: 'هذه الخاصية للأدمن فقط' });
    }

    const { student_code, password } = req.body;
    const sessionId = req.session.activeSessionId;

    const adminUser = await User.findByPk(req.session.userId);
    const passwordMatch = await bcrypt.compare(password, adminUser.password);
    if (!passwordMatch) {
      return res.json({ success: false, message: 'كلمة المرور غير صحيحة' });
    }

    const student = await Student.findOne({ where: { student_code } });
    if (!student) {
      return res.json({ success: false, message: 'كود الطالب غير صحيح' });
    }

    const existingAttendance = await Attendance.findOne({ where: { StudentId: student.id, SessionId: sessionId } });
    if (existingAttendance) {
      return res.json({ success: false, message: 'الطالب مسجل حضوره من قبل' });
    }

    student.balance -= student.price_per_session; // يسمح بالسالب هنا بدون فحص
    await student.save();

    await Attendance.create({
      StudentId: student.id,
      SessionId: sessionId,
      UserId: req.session.userId,
      comment: '⚠️ تسجيل حضور بالقوة من الأدمن رغم نقص الرصيد',
    });

    res.json({ success: true, message: `تم تسجيل حضور ${student.name} (الرصيد الآن: ${student.balance} ج)` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

// ===== Routes بتاعة الامتحانات =====

app.get('/exams', requirePermission('exams'), async (req, res) => {
  const exams = await Exam.findAll({ include: [Subject, Session], order: [['createdAt', 'DESC']] });
  const subjects = await Subject.findAll();
  const allSessions = await Session.findAll({ include: [Center], order: [['lesson_number', 'ASC']] });
  res.render('exams-list', { exams, subjects, allSessions });
});

app.post('/exams', async (req, res) => {
  try {
    const { name, subject_id, session_id, max_score, exam_date } = req.body;
    await Exam.create({
      name,
      SubjectId: subject_id,
      SessionId: session_id || null,
      max_score,
      exam_date,
    });
    res.redirect('/exams');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// صفحة رصد الدرجات لامتحان معين
app.get('/exams/:id', async (req, res) => {
  try {
    const exam = await Exam.findOne({ where: { id: req.params.id }, include: [Subject, Session] });
    if (!exam) return res.status(404).send('❌ الامتحان غير موجود');

    let students;

    if (exam.SessionId) {
      // الامتحان مرتبط بحصة معينة → بس الطلاب اللي حضروا هذه الحصة بالذات
      const attendances = await Attendance.findAll({
        where: { SessionId: exam.SessionId },
      });
      const attendedStudentIds = attendances.map(a => a.StudentId);

      students = await Student.findAll({
        where: { id: attendedStudentIds }, // لو القائمة فاضية، هيرجع مفيش طلاب وهو ده المنطقي
        include: [Center],
        order: [['name', 'ASC']],
      });
    } else {
      // امتحان مستقل (مش مرتبط بحصة) → كل طلاب المادة زي الأول
      students = await Student.findAll({
        where: { SubjectId: exam.SubjectId },
        include: [Center],
        order: [['name', 'ASC']],
      });
    }

    const results = await ExamResult.findAll({ where: { ExamId: exam.id } });
    const existingScores = {};
    results.forEach(r => { existingScores[r.StudentId] = r.score; });

    res.render('exam-scores', { exam, students, existingScores });
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// حفظ كل الدرجات دفعة واحدة
app.post('/exams/:id/scores', async (req, res) => {
  try {
    const examId = req.params.id;

    for (const key in req.body) {
      if (key.startsWith('score_')) {
        const studentId = key.replace('score_', '');
        const score = req.body[key];

        if (score === '' || score === null) continue; // تخطي الفاضي

        const [result, created] = await ExamResult.findOrCreate({
          where: { StudentId: studentId, ExamId: examId },
          defaults: { score, UserId: req.session.userId },
        });

        if (!created) {
          result.score = score;
          result.UserId = req.session.userId;
          await result.save();
        }
        await addPoints(studentId, Math.round(parseFloat(score)));
      }
    }

    res.redirect('/exams/' + examId);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// ===== Routes بتاعة الواجب =====

app.get('/homework/scan', requirePermission('homework_scan'), async (req, res) => {
  if (!req.session.activeSessionId) {
    return res.send('⚠️ لازم تبدأ حصة الأول من <a href="/sessions/new">هنا</a>');
  }
  const activeSession = await Session.findOne({
    where: { id: req.session.activeSessionId },
    include: [Center, Subject],
  });
  const recentSessions = await Session.findAll({
    include: [Center, Subject],
    order: [['createdAt', 'DESC']],
    limit: 30,
  });
  res.render('scan-homework', {
    activeSession,
    recentSessions,
    currentSessionId: req.session.activeSessionId,
    currentPath: '/homework/scan',
  });
});

// ملخص حالة واجب الطالب عبر كل الحصص اللي حضرها
app.post('/homework/scan/summary', async (req, res) => {
  try {
    const { student_code } = req.body;
    const student = await Student.findOne({ where: { student_code } });
    if (!student) return res.json({ success: false, message: 'كود الطالب غير صحيح' });

    const attendanceRecords = await Attendance.findAll({
      where: { StudentId: student.id },
      include: [{ model: Session, include: [Center] }],
      order: [[Session, 'lesson_number', 'ASC']],
    });

    const homeworkRecords = await HomeworkCheck.findAll({ where: { StudentId: student.id } });
    const homeworkMap = {};
    homeworkRecords.forEach(h => { homeworkMap[h.SessionId] = h.status; });

    const homeworkLabels = {
      complete: 'كامل', incomplete: 'مش كامل', no_steps: 'من غير خطوات', not_done: 'مش معمول',
    };

    const summary = attendanceRecords
      .filter(a => a.Session.SubjectId === student.SubjectId)
      .map(a => ({
        lessonNumber: a.Session.lesson_number,
        centerName: a.Session.Center.name,
        homeworkStatus: homeworkMap[a.SessionId] ? homeworkLabels[homeworkMap[a.SessionId]] : 'لم يصحح',
      }));

    res.json({ success: true, studentName: student.name, adminNote: student.admin_note, summary });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

app.post('/homework/scan/lookup', async (req, res) => {
  try {
    const { student_code } = req.body;
    const sessionId = req.session.activeSessionId;

    const student = await Student.findOne({ where: { student_code } });
    if (!student) {
      return res.json({ success: false, message: 'كود الطالب غير صحيح' });
    }

    const attendance = await Attendance.findOne({
      where: { StudentId: student.id, SessionId: sessionId },
    });
    if (!attendance) {
      return res.json({ success: false, message: `الطالب ${student.name} لسه ما سجل حضوره في هذه الحصة` });
    }

    res.json({ success: true, student_id: student.id, student_name: student.name });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

app.post('/homework/scan/save', async (req, res) => {
  try {
    const { student_code, status } = req.body;
    const sessionId = req.session.activeSessionId;

    if (!sessionId) {
      return res.json({ success: false, message: 'مفيش حصة شغالة دلوقتي' });
    }

    const student = await Student.findOne({ where: { student_code } });
    if (!student) {
      return res.json({ success: false, message: 'كود الطالب غير صحيح' });
    }

    const attendance = await Attendance.findOne({
      where: { StudentId: student.id, SessionId: sessionId },
    });
    if (!attendance) {
      return res.json({ success: false, message: `الطالب ${student.name} لسه ما سجل حضوره في هذه الحصة` });
    }

    const [check, created] = await HomeworkCheck.findOrCreate({
      where: { StudentId: student.id, SessionId: sessionId },
      defaults: { status, UserId: req.session.userId },
    });

    if (!created) {
      check.status = status;
      check.UserId = req.session.userId;
      await check.save();
    }

    const pointsMap = { complete: 3, incomplete: 1, no_steps: 0, not_done: -2 };
    await addPoints(student.id, pointsMap[status] || 0);

    res.json({ success: true, message: 'تم حفظ حالة الواجب بنجاح', student_name: student.name });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

// ===== Routes بتاعة الباب =====

app.get('/door/scan', requirePermission('door_scan'), async (req, res) => {
  if (!req.session.activeSessionId) {
    return res.send('⚠️ لازم تبدأ حصة الأول من <a href="/sessions/new">هنا</a>');
  }
  const recentSessions = await Session.findAll({
    include: [Center, Subject],
    order: [['createdAt', 'DESC']],
    limit: 30,
  });
  res.render('scan-door', {
    recentSessions,
    currentSessionId: req.session.activeSessionId,
    currentPath: '/door/scan',
  });
});

app.post('/door/scan', async (req, res) => {
  try {
    const { student_code } = req.body;
    const sessionId = req.session.activeSessionId;

    const student = await Student.findOne({ where: { student_code } });
    if (!student) {
      return res.json({ success: false, message: 'كود الطالب غير صحيح' });
    }

    const attendance = await Attendance.findOne({ where: { StudentId: student.id, SessionId: sessionId } });
    const homework = await HomeworkCheck.findOne({ where: { StudentId: student.id, SessionId: sessionId } });

    if (attendance && homework) {
      return res.json({ success: true, message: `✅ ${student.name} - تمام، الحضور والواجب مسجلين` });
    }

    let missing = [];
    if (!attendance) missing.push('الحضور');
    if (!homework) missing.push('الواجب');

    res.json({ success: false, message: `⚠️ ${student.name} - ناقص: ${missing.join(' و ')}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

// ===== Routes بتاعة إدارة المستخدمين (أدمن بس) =====

app.get('/users', requireAdmin, async (req, res) => {
  const users = await User.findAll({ order: [['createdAt', 'ASC']] });
  res.render('users-list', { users, currentUserId: req.session.userId });
});


app.post('/users', requireAdmin, async (req, res) => {
  try {
    const { name, username, password, role } = req.body;

    const existing = await User.findOne({ where: { username } });
    if (existing) {
      return res.status(400).send('❌ اليوزرنيم ده مستخدم بالفعل، اختار يوزرنيم تاني');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await User.create({ name, username, password: hashedPassword, role });

    res.redirect('/users');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

app.post('/users/:id/delete', requireAdmin, async (req, res) => {
  try {
    // مايقدرش يحذف نفسه
    if (String(req.params.id) === String(req.session.userId)) {
      return res.status(400).send('❌ مينفعش تحذف حسابك بنفسك');
    }
    await User.destroy({ where: { id: req.params.id } });
    res.redirect('/users');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

app.get('/users/:id/permissions', requireAdmin, async (req, res) => {
  const targetUser = await User.findByPk(req.params.id);
  if (!targetUser) return res.status(404).send('❌ غير موجود');
  const currentPermissions = targetUser.permissions ? JSON.parse(targetUser.permissions) : [];
  res.render('edit-permissions', { targetUser, currentPermissions, PERMISSIONS_LIST });
});

app.post('/users/:id/permissions', requireAdmin, async (req, res) => {
  let selected = req.body.permissions || [];
  if (!Array.isArray(selected)) selected = [selected]; // لو اختار صلاحية واحدة بس
  await User.update({ permissions: JSON.stringify(selected) }, { where: { id: req.params.id } });
  res.redirect('/users');
});

app.get('/follow-up', requirePermission('students_view'), async (req, res) => {
  try {
    const students = await Student.findAll({
      include: [Center, Subject],
      attributes: ['id', 'name', 'student_code', 'balance', 'price_per_session', 'CenterId', 'SubjectId'],
    });

    // نجيب كل الحضور والواجب مرة واحدة بدل حلقة استعلامات
    const allAttendance = await Attendance.findAll({
      include: [{ model: Session, attributes: ['lesson_number', 'SubjectId', 'status'] }],
      attributes: ['StudentId', 'SessionId', 'createdAt'],
    });
    const allHomework = await HomeworkCheck.findAll({
      attributes: ['StudentId', 'SessionId', 'status'],
    });

    // نجمعهم في Maps عشان نوصلهم بسرعة من غير استعلام جديد لكل طالب
    const attendanceByStudent = {};
    allAttendance.forEach(a => {
      if (!attendanceByStudent[a.StudentId]) attendanceByStudent[a.StudentId] = [];
      attendanceByStudent[a.StudentId].push(a);
    });

    const homeworkByKey = {};
    allHomework.forEach(h => { homeworkByKey[`${h.StudentId}_${h.SessionId}`] = h.status; });

    const allSessions = await Session.findAll({ attributes: ['id', 'lesson_number', 'SubjectId', 'CenterId', 'status'] });

    const result = [];
    for (const s of students) {
      const reasons = [];
      if (s.balance < s.price_per_session) reasons.push('رصيد منخفض');

      const ownGroupSessions = allSessions
        .filter(sess => sess.CenterId === s.CenterId && sess.SubjectId === s.SubjectId && sess.status === 'normal')
        .sort((a, b) => b.lesson_number - a.lesson_number)
        .slice(0, 3);

      const studentAttendance = attendanceByStudent[s.id] || [];
      const attendedLessonNumbers = new Set(
        studentAttendance.filter(a => a.Session.SubjectId === s.SubjectId).map(a => a.Session.lesson_number)
      );

      const absentCount = ownGroupSessions.filter(gs => !attendedLessonNumbers.has(gs.lesson_number)).length;
      if (ownGroupSessions.length >= 2 && absentCount >= 2) {
        reasons.push(`غياب ${absentCount} من آخر ${ownGroupSessions.length} حصص`);
      }

      const recentAttendance = studentAttendance
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 3);

      let badHomeworkCount = 0;
      recentAttendance.forEach(att => {
        const status = homeworkByKey[`${s.id}_${att.SessionId}`];
        if (!status || status === 'not_done' || status === 'incomplete') badHomeworkCount++;
      });
      if (badHomeworkCount >= 2) reasons.push(`واجبات ضعيفة في ${badHomeworkCount} من آخر حصص`);

      if (reasons.length > 0) result.push({ student: s, reasons });
    }

    res.render('follow-up', { result });
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// ===== API بتاعة بوابة الطالب وولي الأمر (مستقلة، تستخدم Token بدل الجلسة) =====

app.get('/users/:id/stats', requireAdmin, async (req, res) => {
  try {
    const targetUser = await User.findByPk(req.params.id);
    if (!targetUser) return res.status(404).send('❌ غير موجود');

    const attendanceCount = await Attendance.count({ where: { UserId: targetUser.id } });
    const homeworkCount = await HomeworkCheck.count({ where: { UserId: targetUser.id } });
    const examResultCount = await ExamResult.count({ where: { UserId: targetUser.id } });
    const studentsRegistered = await Student.count({ where: { UserId: targetUser.id } });

    // نشاط آخر 7 أيام
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 6);
    weekAgo.setHours(0, 0, 0, 0);

    const recentAttendance = await Attendance.findAll({
      where: { UserId: targetUser.id, createdAt: { [Op.gte]: weekAgo } },
      attributes: ['createdAt'],
    });

    const dayCounts = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekAgo);
      d.setDate(d.getDate() + i);
      dayCounts[d.toISOString().slice(0, 10)] = 0;
    }
    recentAttendance.forEach(a => {
      const key = new Date(a.createdAt).toISOString().slice(0, 10);
      if (dayCounts[key] !== undefined) dayCounts[key]++;
    });

    res.render('user-stats', {
      targetUser, attendanceCount, homeworkCount, examResultCount, studentsRegistered, dayCounts,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// دخول الطالب: برقم تليفونه + كود الطالب
app.post('/api/portal/student-login', async (req, res) => {
  try {
    const { phone, student_code } = req.body;

    const student = await Student.findOne({ where: { phone, student_code } });
    if (!student) {
      return res.status(401).json({ success: false, message: 'رقم التليفون أو الكود غير صحيح' });
    }
    if (student.is_blocked) {
      return res.status(403).json({ success: false, message: '⛔ تم حظر هذا الحساب. تواصل مع الإدارة.' });
    }

    const token = jwt.sign(
      { studentId: student.id, type: 'student' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ success: true, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

// دخول ولي الأمر: بكود الطالب + رقم ولي الأمر
app.post('/api/portal/parent-login', async (req, res) => {
  try {
    const { student_code, parent_phone } = req.body;

    const student = await Student.findOne({ where: { student_code, parent_phone } });
    if (!student) {
      return res.status(401).json({ success: false, message: 'كود الطالب أو رقم ولي الأمر غير صحيح' });
    }

    const token = jwt.sign(
      { studentId: student.id, type: 'parent' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ success: true, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

// Middleware يتأكد من الـ Token الموجود في الهيدر، ويحدد نوع الحساب المطلوب
function verifyPortalToken(requiredType) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'غير مسجل دخول' });
    }
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.type !== requiredType) {
        return res.status(403).json({ success: false, message: 'غير مسموح' });
      }
      req.portalStudentId = decoded.studentId;
      next();
    } catch (err) {
      return res.status(401).json({ success: false, message: 'انتهت صلاحية الدخول، سجل دخول تاني' });
    }
  };
}

// جلب بيانات الطالب الكاملة (بيستخدمها الطالب وولي الأمر مع بعض)
async function buildStudentData(studentId) {
  const student = await Student.findOne({
    where: { id: studentId },
    include: [Center, Subject],
  });
  if (!student) return null;

  const ownSessions = await Session.findAll({
    where: { CenterId: student.CenterId, SubjectId: student.SubjectId },
    include: [Center, Subject],
    order: [['lesson_number', 'ASC']],
  });

  const attendanceRecords = await Attendance.findAll({
    where: { StudentId: student.id },
    include: [{ model: Session, include: [Center] }, User],
  });
  const attendanceByLesson = {};
  attendanceRecords.forEach(a => {
    if (a.Session.SubjectId === student.SubjectId) attendanceByLesson[a.Session.lesson_number] = a;
  });

  const homeworkRecords = await HomeworkCheck.findAll({
    where: { StudentId: student.id },
    include: [{ model: Session, include: [Center] }, User],
  });
  const homeworkByLesson = {};
  homeworkRecords.forEach(h => {
    if (h.Session.SubjectId === student.SubjectId) homeworkByLesson[h.Session.lesson_number] = h;
  });

  const examResults = await ExamResult.findAll({
    where: { StudentId: student.id },
    include: [{ model: Exam, include: [Session] }, User],
  });
  const examByLesson = {};
  examResults.forEach(r => {
    if (r.Exam.Session) examByLesson[r.Exam.Session.lesson_number] = r;
  });

  // نجمع كل أرقام الحصص النسبية اللي للطالب علاقة بيها: سواء من مجموعته، أو حضرها في مكان تاني
  const lessonNumbersSet = new Set();
  ownSessions.forEach(s => lessonNumbersSet.add(s.lesson_number));
  Object.keys(attendanceByLesson).forEach(n => lessonNumbersSet.add(parseInt(n)));

  const lessonNumbers = Array.from(lessonNumbersSet).sort((a, b) => a - b);

  const ownSessionByLesson = {};
  ownSessions.forEach(s => { ownSessionByLesson[s.lesson_number] = s; });

  const sessions = lessonNumbers.map(lessonNumber => {
    const ownSession = ownSessionByLesson[lessonNumber];
    const att = attendanceByLesson[lessonNumber];
    const hw = homeworkByLesson[lessonNumber];
    const exam = examByLesson[lessonNumber];

    let attendanceStatus, attendedCenterName = null;
    if (att) {
      attendanceStatus = 'attended';
      attendedCenterName = att.Session.Center.name;
    } else if (ownSession && ownSession.status === 'cancelled') {
      attendanceStatus = 'cancelled';
    } else {
      attendanceStatus = 'absent';
    }

    return {
      lessonNumber,
      date: ownSession ? ownSession.session_date : (att ? att.Session.session_date : null),
      attendanceStatus,
      attendedCenterName,
      attendanceUser: att ? (att.User ? att.User.name : null) : null,
      attendanceTime: att ? att.attended_at : null,
      comment: att ? att.comment : null,
      payment: att ? att.payment_collected : null,
      homeworkStatus: hw ? hw.status : null,
      homeworkUser: hw ? (hw.User ? hw.User.name : null) : null,
      homeworkTime: hw ? hw.createdAt : null,
      examScore: exam ? exam.score : null,
      examMax: exam ? exam.Exam.max_score : null,
      examUser: exam ? (exam.User ? exam.User.name : null) : null,
      examTime: exam ? exam.createdAt : null,
    };
  });

  const videos = await Video.findAll({
    where: { SubjectId: student.SubjectId },
    include: [VideoPart],
    order: [['createdAt', 'ASC']],
  });
  const watchRecords = await WatchProgress.findAll({ where: { StudentId: student.id } });
  const watchMap = {};
  watchRecords.forEach(w => { watchMap[w.VideoPartId] = w.watched_seconds; });

  const videosData = videos.map(v => ({
    title: v.title,
    parts: v.VideoParts.map(p => ({
      id: p.id,
      partName: p.part_name,
      videoUrl: p.video_url,
      durationSeconds: p.duration_seconds,
      watchedSeconds: watchMap[p.id] || 0,
    })),
  }));

  const warnings = await Warning.findAll({
    where: { StudentId: student.id },
    order: [['createdAt', 'ASC']],
  });

  const transactions = await BalanceTransaction.findAll({
    where: { StudentId: student.id },
    order: [['createdAt', 'DESC']],
    limit: 30,
  });

  return {
    student: {
      name: student.name,
      studentCode: student.student_code,
      subjectName: student.Subject.name,
      centerName: student.Center.name,
      balance: student.balance,
      bookletStatus: student.booklet_status,
      isBlocked: student.is_blocked,
      points: student.points,
      warnings: warnings.map(w => ({ reason: w.reason, time: w.createdAt })),
    },
    sessions,
    videos: videosData,
    warnings: warnings.map(w => ({ reason: w.reason, time: w.createdAt })),
    transactions: transactions.map(t => ({
      amount: t.amount,
      reason: t.reason,
      time: t.createdAt,
    })),
  };
}

// بيانات الطالب (الطالب بس يقدر يطلبها)
app.get('/api/portal/student/data', verifyPortalToken('student'), async (req, res) => {
  const data = await buildStudentData(req.portalStudentId);
  if (!data) return res.status(404).json({ success: false, message: 'غير موجود' });
  res.json({ success: true, data });
});

// بيانات ولي الأمر (نفس البيانات بالظبط، بس endpoint منفصل للتنظيم والتحقق)
app.get('/api/portal/parent/data', verifyPortalToken('parent'), async (req, res) => {
  const data = await buildStudentData(req.portalStudentId);
  if (!data) return res.status(404).json({ success: false, message: 'غير موجود' });
  res.json({ success: true, data });
});

// QR Code بصيغة صورة Base64 (الطالب بس)
app.get('/api/portal/student/qrcode', verifyPortalToken('student'), async (req, res) => {
  const student = await Student.findByPk(req.portalStudentId);
  if (!student) return res.status(404).json({ success: false });
  const qrCodeImage = await QRCode.toDataURL(student.student_code);
  res.json({ success: true, qrCodeImage, code: student.student_code });
});

// تسجيل/تحديث مشاهدة فيديو (الطالب بس)
app.post('/api/portal/watch-progress', verifyPortalToken('student'), async (req, res) => {
  try {
    const { video_part_id, watched_seconds } = req.body;
    const studentId = req.portalStudentId;

    const [progress, created] = await WatchProgress.findOrCreate({
      where: { StudentId: studentId, VideoPartId: video_part_id },
      defaults: { watched_seconds },
    });

    if (!created && watched_seconds > progress.watched_seconds) {
      progress.watched_seconds = watched_seconds;
      await progress.save();
    }

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

// قائمة الدروس (الفيديوهات) المتاحة لمادة الطالب - بدون استهلاك مشاهدة، بس لعرض الحالة
app.get('/api/portal/student/lessons', verifyPortalToken('student'), async (req, res) => {
  try {
    const student = await Student.findByPk(req.portalStudentId);

    const videos = await Video.findAll({
      where: { SubjectId: student.SubjectId },
      include: [{ model: Session, required: true, include: [Center] }],
      order: [['createdAt', 'DESC']],
    });

    const grants = await VideoAccessGrant.findAll({ where: { StudentId: student.id } });
    const grantBySessionId = {};
    grants.forEach(g => { grantBySessionId[g.SessionId] = g; });

    const lessons = videos.map(v => {
      const grant = grantBySessionId[v.SessionId];
      let status, viewsUsed = 0, maxViews = 0;

      if (v.Session.is_free_for_all) {
        status = 'free';
      } else if (grant) {
        status = grant.views_used >= grant.max_views ? 'exhausted' : 'granted';
        viewsUsed = grant.views_used;
        maxViews = grant.max_views;
      } else {
        status = 'locked'; // لسه محتاج نتحقق وقت الفتح الفعلي
      }

      return {
        videoId: v.id,
        title: v.title,
        lessonNumber: v.Session.lesson_number,
        date: v.Session.session_date,
        status,
        viewsUsed,
        maxViews,
        price: student.price_per_session,
      };
    });

    res.json({ success: true, lessons });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

// طلب فتح/استهلاك مشاهدة لدرس معين (الخطوة الأهم)
app.post('/api/portal/student/lessons/:videoId/access', verifyPortalToken('student'), async (req, res) => {
  try {
    const { confirm_payment } = req.body;
    const student = await Student.findByPk(req.portalStudentId);
    const video = await Video.findOne({ where: { id: req.params.videoId }, include: [Session] });
    if (!video) return res.status(404).json({ success: false, message: 'الدرس غير موجود' });

    const session = video.Session;

    // 1) الحالة المجانية للجميع - فتح فوري بلا حدود + تسجيل حضور
    if (session.is_free_for_all) {
      await ensureAttendance(student.id, session.id, '📹 حضر الحصة (مفتوحة مجانًا للجميع)');
      return res.json({ success: true, unlimited: true });
    }

    // 2) فيه صلاحية مسجلة بالفعل (حضور سابق / دفع سابق / فتح أدمن)
    let grant = await VideoAccessGrant.findOne({ where: { StudentId: student.id, SessionId: session.id } });

    if (grant) {
      if (grant.views_used >= grant.max_views) {
        return res.json({ success: false, message: 'لقد استهلكت كل مرات المشاهدة المتاحة لهذا الدرس' });
      }
      grant.views_used += 1;
      await grant.save();

      const methodComments = {
        attended: '📹 حضر الحصة (سبق حضوره بالسنتر)',
        paid: '📹 حضر عن طريق دفع ثمن مشاهدة الفيديو أونلاين',
        admin_free: '📹 فُتحت له الحصة مجانًا من الأدمن',
        admin_paid: '📹 فُتحت له الحصة من الأدمن (مدفوعة بدون خصم)',
      };
      await ensureAttendance(student.id, session.id, methodComments[grant.method] || '📹 حضر الحصة أونلاين (فيديو)');

      return res.json({ success: true, viewsUsed: grant.views_used, maxViews: grant.max_views });
    }

    // 3) مفيش صلاحية - نتحقق هل حضر هذه الحصة في أي سنتر فعلي (غير أونلاين)
    const attendedInCenter = await Attendance.findOne({
      where: { StudentId: student.id },
      include: [{
        model: Session,
        where: { lesson_number: session.lesson_number, SubjectId: student.SubjectId },
        include: [{ model: Center, where: { name: { [Op.ne]: 'أونلاين' } } }],
      }],
    });

    if (attendedInCenter) {
      grant = await VideoAccessGrant.create({
        StudentId: student.id,
        SessionId: session.id,
        method: 'attended',
        max_views: session.views_if_attended,
        views_used: 1,
      });
      // الحضور هنا مسجل بالفعل أصلاً (هو سبب الأهلية)، بس نتأكد بنفس الدالة لضمان التناسق
      await ensureAttendance(student.id, session.id, '📹 حضر الحصة (سبق حضوره بالسنتر)');
      return res.json({ success: true, viewsUsed: 1, maxViews: grant.max_views });
    }

    // 4) لسه مدفوعش - لو ماأكدش الدفع، نرجع نطلب تأكيد
    if (!confirm_payment) {
      return res.json({
        success: false,
        requiresPayment: true,
        price: student.price_per_session,
        message: `لم تحضر هذه الحصة في السنتر. هل توافق على دفع ${student.price_per_session} ج من رصيدك لمشاهدتها؟`,
      });
    }

    // 5) أكد الدفع - نتحقق من الرصيد وننفذ
    if (student.balance < student.price_per_session) {
      return res.json({ success: false, message: 'رصيدك غير كافٍ لدفع ثمن هذه الحصة' });
    }

    student.balance -= student.price_per_session;
    await student.save();

    await BalanceTransaction.create({
      StudentId: student.id,
      amount: -student.price_per_session,
      reason: `دفع لمشاهدة حصة أونلاين (سيريال ${session.serial_number})`,
    });

    grant = await VideoAccessGrant.create({
      StudentId: student.id,
      SessionId: session.id,
      method: 'paid',
      max_views: session.views_if_paid,
      views_used: 1,
    });

    await ensureAttendance(student.id, session.id, '📹 حضر عن طريق دفع ثمن مشاهدة الفيديو أونلاين');

    res.json({ success: true, viewsUsed: 1, maxViews: grant.max_views, remainingBalance: student.balance });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

async function addPoints(studentId, amount) {
  if (amount === 0) return;
  await Student.increment('points', { by: amount, where: { id: studentId } });
}

app.get('/api/portal/leaderboard', verifyPortalToken('student'), async (req, res) => {
  try {
    const me = await Student.findByPk(req.portalStudentId);
    const sameSubject = await Student.findAll({
      where: { SubjectId: me.SubjectId },
      attributes: ['id', 'name', 'points'],
      order: [['points', 'DESC']],
    });
    const myRank = sameSubject.findIndex(s => s.id === me.id) + 1;
    const top3 = sameSubject.slice(0, 3).map((s, i) => ({
      rank: i + 1,
      name: s.id === me.id ? 'أنت' : s.name.split(' ')[0],
      points: s.points,
      isMe: s.id === me.id,
    }));
    res.json({ success: true, myPoints: me.points, myRank, total: sameSubject.length, top3 });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

// دالة موحّدة: تتأكد إن الطالب له سجل حضور في الحصة، ولو مش موجود تعمله
async function ensureAttendance(studentId, sessionId, comment) {
  const existing = await Attendance.findOne({ where: { StudentId: studentId, SessionId: sessionId } });
  if (existing) return existing;
  return await Attendance.create({ StudentId: studentId, SessionId: sessionId, comment });
}

// جلب فيديوهات الدرس (شرح/أسئلة/حل واجب) - بعد التأكد من وجود صلاحية فعلية
app.get('/api/portal/student/lessons/:videoId/parts', verifyPortalToken('student'), async (req, res) => {
  try {
    const student = await Student.findByPk(req.portalStudentId);
    const video = await Video.findOne({ where: { id: req.params.videoId }, include: [Session] });
    if (!video) return res.status(404).json({ success: false });

    // تأكيد إن عنده صلاحية فعلية (مجاني، أو غرانت فيه مشاهدات متاحة)
    if (!video.Session.is_free_for_all) {
      const grant = await VideoAccessGrant.findOne({ where: { StudentId: student.id, SessionId: video.SessionId } });
      if (!grant) return res.status(403).json({ success: false, message: 'غير مسموح' });
    }

    const parts = await VideoPart.findAll({ where: { VideoId: video.id }, order: [['order_index', 'ASC']] });
    const watchRecords = await WatchProgress.findAll({ where: { StudentId: student.id } });
    const watchMap = {};
    watchRecords.forEach(w => { watchMap[w.VideoPartId] = w.watched_seconds; });

    const grouped = { explanation: [], questions: [], homework_solution: [] };
    parts.forEach(p => {
      grouped[p.category].push({
        id: p.id,
        orderIndex: p.order_index,
        sourceType: p.source_type,
        videoUrl: p.video_url,
        filePath: p.file_path,
        durationSeconds: p.duration_seconds,
        watchedSeconds: watchMap[p.id] || 0,
      });
    });

    res.json({ success: true, title: video.title, parts: grouped });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

// ===== إدارة الفيديوهات (أدمن بس) =====

app.get('/admin/videos', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  const allSessions = await Session.findAll({ include: [Center, Subject], order: [['createdAt', 'DESC']] });
  const videos = await Video.findAll({
    include: [{ model: Session, required: true, include: [Center, Subject] }], // required: true يستبعد أي فيديو مالوش حصة مرتبطة
    order: [['createdAt', 'DESC']],
  });
  res.render('manage-videos', { allSessions, videos });
});

app.post('/admin/videos/create', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  try {
    const { session_id, title } = req.body;
    const session = await Session.findByPk(session_id);
    await Video.create({ title, SubjectId: session.SubjectId, SessionId: session_id });
    res.redirect('/admin/videos');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

app.get('/admin/videos/:id', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  const video = await Video.findOne({ where: { id: req.params.id }, include: [{ model: Session, include: [Center, Subject] }] });
  if (!video) return res.status(404).send('❌ غير موجود');
  const videoParts = await VideoPart.findAll({ where: { VideoId: video.id }, order: [['order_index', 'ASC']] });
  res.render('manage-video-parts', { video, videoParts });
});

app.post('/admin/videos/:id/add-part', requirePermissionOrAdmin('admin_videos'), videoUpload.single('video_file'), async (req, res) => {
  try {
    const { category, order_index, source_type, video_url, duration_seconds } = req.body;
    const partData = { category, order_index, source_type, duration_seconds, VideoId: req.params.id };

    if (source_type === 'upload' && req.file) {
      partData.file_path = `/uploads/videos/${req.file.filename}`;
    } else {
      partData.video_url = video_url;
    }

    await VideoPart.create(partData);
    res.redirect('/admin/videos/' + req.params.id);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

app.post('/admin/videos/part/:id/delete', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  const part = await VideoPart.findByPk(req.params.id);
  const videoId = part.VideoId;
  await VideoPart.destroy({ where: { id: req.params.id } });
  res.redirect('/admin/videos/' + videoId);
});

app.post('/admin/videos/delete/:id', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  try {
    await VideoPart.destroy({ where: { VideoId: req.params.id } });
    await VideoAccessGrant.destroy({ where: { SessionId: (await Video.findByPk(req.params.id)).SessionId } });
    await WatchProgress.destroy({ where: { VideoPartId: null } }); // تنظيف احتياطي، آمن
    await Video.destroy({ where: { id: req.params.id } });
    res.redirect('/admin/videos');
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

app.get('/admin/videos/:id/access', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  const video = await Video.findOne({ where: { id: req.params.id }, include: [Session] });
  if (!video) return res.status(404).send('❌ غير موجود');

  const students = await Student.findAll({ where: { SubjectId: video.SubjectId }, order: [['name', 'ASC']] });
  const grants = await VideoAccessGrant.findAll({ where: { SessionId: video.SessionId } });
  const grantsMap = {};
  grants.forEach(g => { grantsMap[g.StudentId] = g; });

  res.render('video-access-control', { video, students, grantsMap });
});

app.post('/admin/videos/:id/session-settings', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  const { is_free_for_all, views_if_attended, views_if_paid } = req.body;
  const video = await Video.findByPk(req.params.id);
  await Session.update({
    is_free_for_all: is_free_for_all === 'on',
    views_if_attended,
    views_if_paid,
  }, { where: { id: video.SessionId } });
  res.redirect('/admin/videos/' + req.params.id + '/access');
});

app.post('/admin/videos/:id/grant/:studentId', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  const { method, max_views } = req.body;
  const video = await Video.findByPk(req.params.id);

  const [grant, created] = await VideoAccessGrant.findOrCreate({
    where: { StudentId: req.params.studentId, SessionId: video.SessionId },
    defaults: { method, max_views },
  });

  if (!created) {
    grant.method = method;
    grant.max_views = max_views;
    await grant.save();
  }

  res.redirect('/admin/videos/' + req.params.id + '/access');
});

// ===== نظام الإنذارات والحظر =====

app.post('/students/:id/warning/add', requireAdmin, async (req, res) => {
  try {
    const count = await Warning.count({ where: { StudentId: req.params.id } });
    if (count >= 3) return res.status(400).send('❌ الطالب وصل للحد الأقصى من الإنذارات');

    await Warning.create({
      StudentId: req.params.id,
      reason: req.body.reason || null,
      UserId: req.session.userId,
    });

    if (count + 1 >= 3) {
      await Student.update({ is_blocked: true }, { where: { id: req.params.id } });
    }

    res.redirect('/students/' + req.params.id);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

app.post('/students/:id/warning/remove/:warningId', requireAdmin, async (req, res) => {
  try {
    await Warning.destroy({ where: { id: req.params.warningId, StudentId: req.params.id } });
    res.redirect('/students/' + req.params.id);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

app.post('/students/:id/unblock', requireAdmin, async (req, res) => {
  try {
    await Student.update({ is_blocked: false }, { where: { id: req.params.id } });
    res.redirect('/students/' + req.params.id);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

app.post('/attendance/:id/delete', requireAdmin, async (req, res) => {
  try {
    const attendance = await Attendance.findByPk(req.params.id);
    if (!attendance) return res.status(404).send('❌ غير موجود');

    const studentId = attendance.StudentId;
    const sessionId = attendance.SessionId;
    const redirectTo = req.body.redirect_to;

    const student = await Student.findByPk(studentId);
    student.balance += student.price_per_session;
    await student.save();

    await BalanceTransaction.create({
      StudentId: studentId,
      amount: student.price_per_session,
      reason: 'استرجاع رصيد بعد حذف سجل حضور',
      UserId: req.session.userId,
    });

    await Attendance.destroy({ where: { id: req.params.id } });

    res.redirect(redirectTo || ('/students/' + studentId));
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

app.post('/sessions/:id/closing', requireClosingAuth, async (req, res) => {
  const { cost_per_normal, cost_per_reduced } = req.body;
  await Session.update({
    cost_per_normal: cost_per_normal === '' ? null : cost_per_normal,
    cost_per_reduced: cost_per_reduced === '' ? null : cost_per_reduced,
  }, { where: { id: req.params.id } });
  res.redirect('/sessions/' + req.params.id + '/report');
});

app.get('/admin/closing', requireClosingAuth, async (req, res) => {
  const { start, end, center_id } = req.query;
  let result = null;

  if (start && end) {
    const sessionWhere = { session_date: { [Op.between]: [start, end] } };
    if (center_id) sessionWhere.CenterId = center_id;

    const sessions = await Session.findAll({ where: sessionWhere });
    const sessionIds = sessions.map(s => s.id);

    const attendances = await Attendance.findAll({ where: { SessionId: sessionIds } });
    const totalCash = attendances.reduce((sum, a) => sum + (a.payment_collected || 0), 0);

    result = { sessionsCount: sessions.length, totalCash };
  }

  const centers = await Center.findAll();
  res.render('closing-period', { result, centers, filters: { start: start || '', end: end || '', center_id: center_id || '' } });
});

// نسخة احتياطية تلقائية كل يوم الساعة 3 الفجر
if (!process.env.VERCEL) cron.schedule('0 3 * * *', () => {
  console.log('⏳ جاري عمل نسخة احتياطية تلقائية...');
  exec('node backup.js', (error, stdout) => {
    if (error) console.error('❌ فشل:', error.message);
    else console.log(stdout);
  });
});

// تشغيل السيرفر + التأكد من الاتصال بقاعدة البيانات
// async function startServer() {
//   try {
//     await sequelize.authenticate();
//     console.log('✅ تم الاتصال بقاعدة البيانات بنجاح');

//     await sequelize.sync();
//     console.log('✅ تم تجهيز الجداول بنجاح');

//     const sslOptions = {
//       key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
//       cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
//     };

//     const httpsServer = https.createServer(sslOptions, app);

//     httpsServer.listen(PORT, '0.0.0.0', () => {
//       const localIP = getLocalIP();
//       const networkUrl = `https://${localIP}:${PORT}`;

//       console.log('');
//       console.log('🚀 السيرفر شغال بنجاح!');
//       console.log(`💻 من جهازك: https://localhost:${PORT}`);
//       console.log(`📍 من أي جهاز تاني على نفس الشبكة: ${networkUrl}`);
//       console.log('');
//       console.log('📷 اسكان الكود ده من موبايلك للدخول مباشرة:');
//       console.log('');

//       qrcodeTerminal.generate(networkUrl, { small: true });

//       console.log('');
//       console.log('⚠️ أول ما تفتح اللينك من المتصفح، هيظهرلك تحذير "غير آمن" - ده طبيعي لأنها شهادة محلية. دوس "Advanced" ثم "Proceed anyway" أو "متابعة" للدخول.');
//       console.log('');
//     });
//   } catch (error) {
//     console.error('❌ فشل الاتصال بقاعدة البيانات:', error.message);
//   }
// }


async function startServer() {
  try {
    await sequelize.authenticate();
    console.log('✅ تم الاتصال بقاعدة البيانات بنجاح');
    // IMPORTANT: منع sync المؤقتًا لتجنب Duplicate keys أثناء تشغيل السيرفر
    // await sequelize.sync();
    console.log('✅ تم تجهيز اتصال قاعدة البيانات بنجاح (تم تعطيل sequelize.sync مؤقتًا)');

    if (process.env.NODE_ENV === 'production') {
      // على Render: HTTP عادي (Render بيعمل HTTPS تلقائياً)
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 السيرفر شغال على البورت ${PORT}`);
      });
    } else {
      // محلياً: HTTPS بشهادة self-signed
      const https = require('https');
      const sslOptions = {
        key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
      };
      const httpsServer = https.createServer(sslOptions, app);
      httpsServer.listen(PORT, '0.0.0.0', () => {
        const localIP = getLocalIP();
        const networkUrl = `https://${localIP}:${PORT}`;
        console.log('🚀 السيرفر شغال بنجاح!');
        console.log(`💻 من جهازك: https://localhost:${PORT}`);
        console.log(`📍 من الشبكة: ${networkUrl}`);
        qrcodeTerminal.generate(networkUrl, { small: true });
      });
    }
  } catch (error) {
    console.error('❌ فشل الاتصال بقاعدة البيانات:', error.message);
    process.exit(1);
  }
}

if (process.env.VERCEL) {
  module.exports = app;
} else {
  startServer();
}
