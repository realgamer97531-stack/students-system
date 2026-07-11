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
const RechargeCode = require('./models/RechargeCode');
const crypto = require('crypto');

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
const Booklet = require('./models/Booklet');
const StudentBooklet = require('./models/StudentBooklet');
const BookletReservation = require('./models/BookletReservation');
const ensureBookletReservationSchema = require('./utils/ensureBookletReservationSchema');
const checkReceiptWithAI = require('./utils/checkReceiptWithAI');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

Booklet.belongsTo(Subject, { foreignKey: 'SubjectId' });
Subject.hasMany(Booklet, { foreignKey: 'SubjectId' });
StudentBooklet.belongsTo(Student, { foreignKey: 'StudentId' });
StudentBooklet.belongsTo(Booklet, { foreignKey: 'BookletId' });
Student.hasMany(StudentBooklet, { foreignKey: 'StudentId' });
Booklet.hasMany(StudentBooklet, { foreignKey: 'BookletId' });
BookletReservation.belongsTo(Student, { foreignKey: 'StudentId' });
BookletReservation.belongsTo(Booklet, { foreignKey: 'BookletId' });
Student.hasMany(BookletReservation, { foreignKey: 'StudentId' });

require('./models/associations')();

// ✅ لازم نعرف app الأول قبل ما نستخدمه في أي route
const app = express();
const PORT = process.env.PORT || 3000;
const sessionSecret = process.env.SESSION_SECRET || process.env.JWT_SECRET;
app.use(cors()); // يسمح لأي موقع يتواصل مع الـ API بتاعنا
app.use(compression());
app.use(cors({
  origin: [
    'https://studyisfunny.online', 
    'https://students-system-studyisfunny-g622.vercel.app'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true 
}));

// Middleware عشان السيرفر يقدر يقرا بيانات الفورمز
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// عشان نقدر نستخدم ملفات CSS / JS / صور من فولدر public
app.use(express.static(path.join(__dirname, 'public')));

app.get('/_health', (req, res) => {
  res.json({
    ok: true,
    vercel: Boolean(process.env.VERCEL),
    hasDbConfig: ['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST'].every((key) => Boolean(process.env[key])),
    hasSessionSecret: Boolean(sessionSecret),
    hasJwtSecret: Boolean(process.env.JWT_SECRET),
  });
});

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
  secret: sessionSecret,
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

// إتاحة بيانات المستخدم تلقائيًا في كل صفحة EJS
app.use((req, res, next) => {
  res.locals.userName = req.session.userName;
  res.locals.userRole = req.session.userRole;
  next();
});

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

// ===== Settings Route =====
app.get('/settings', (req, res) => {
  res.render('settings');
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

    const studentBooklets = await StudentBooklet.findAll({
      where: { StudentId: student.id },
      include: [Booklet],
    });
    const availableBooklets = await Booklet.findAll({
      where: { SubjectId: student.SubjectId, is_active: true },
    });

    res.render('student-profile', {
      student,
      centers,
      subjects,
      attendanceRows,
      transactions,
      examResults: examResults.filter(r => !r.Exam.Session),
      videoWatchData,
      warnings,
      studentBooklets,
      availableBooklets,
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

app.post('/students/:id/points', requireAdmin, async (req, res) => {
  try {
    const { amount, reason, type } = req.body;
    const student = await Student.findByPk(req.params.id);
    const signedAmount = type === 'deduct' ? -Math.abs(parseInt(amount)) : Math.abs(parseInt(amount));

    await Student.increment('points', { by: signedAmount, where: { id: req.params.id } });

    await BalanceTransaction.create({
      StudentId: student.id,
      amount: signedAmount,
      reason: `نقاط: ${reason || (type === 'deduct' ? 'خصم يدوي' : 'إضافة يدوية')}`,
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
    const { name, phone, parent_phone, price_per_session, balance, booklet_status, center_id, subject_id, admin_password } = req.body;

    // البحث عن طالب بنفس البيانات
    const existingStudent = await Student.findOne({
      where: {
        name: name,
        phone: phone,
        parent_phone: parent_phone,
        CenterId: center_id,
        SubjectId: subject_id,
      },
    });

    // إذا وجدنا طالب بنفس البيانات
    if (existingStudent) {
      // التحقق من كلمة المرور الإدارية
      if (admin_password !== process.env.ADMIN_DUPLICATE_PASSWORD) {
        return res.status(409).json({
          success: false,
          isDuplicate: true,
          message: `⚠️ تحذير: وجدنا طالب بنفس البيانات!\n\nالاسم: ${existingStudent.name}\nالتليفون: ${existingStudent.phone}\nولي الأمر: ${existingStudent.parent_phone}\n\nهل تريد المتابعة بإدخال كلمة المرور الإدارية؟`,
          studentCode: existingStudent.student_code,
        });
      }
    }

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

    const assistantAttendances = await AssistantAttendance.findAll({
      where: { SessionId: session.id },
      include: [User],
      order: [['check_in', 'ASC']],
    });
    const allUsers = await User.findAll({ order: [['name', 'ASC']] });

    res.render('session-report', {
      session, attendedRows, absentStudents,
      closing: { normalCount, reducedCount, freeCount, totalRevenue, totalCost },
      totalCashCollected,
      assistantAttendances,
      allUsers,
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
    if (!activeSession) return res.json({ success: false, message: '⚠️ مفيش حصة شغالة' });
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

    const booklets = await Booklet.findAll({
      where: { SubjectId: student.SubjectId, is_active: true },
      order: [['order_index', 'ASC']],
    });

    const bookletStatuses = await Promise.all(booklets.map(async (booklet) => {
      const studentBooklet = await StudentBooklet.findOne({
        where: { StudentId: student.id, BookletId: booklet.id },
      });
      const reservation = await BookletReservation.findOne({
        where: { StudentId: student.id, BookletId: booklet.id, status: { [Op.ne]: 'rejected' } },
      });

      const paidAmount = studentBooklet ? studentBooklet.paid_amount : 0;
      const remaining = Math.max(0, (booklet.sell_price || 0) - paidAmount);

      return {
        id: booklet.id,
        name: booklet.name,
        sellPrice: booklet.sell_price,
        paidAmount,
        remaining,
        studentBookletId: studentBooklet ? studentBooklet.id : null,
        isDelivered: Boolean(studentBooklet && studentBooklet.is_delivered),
        reservationStatus: reservation ? reservation.status : null,
        reservationMethod: reservation ? reservation.payment_method : null,
        isFullyPaid: remaining <= 0,
      };
    }));

    res.json({
      success: true,
      student: {
        id: student.id,
        name: student.name,
        code: student.student_code,
        balance: student.balance,
        pricePerSession: student.price_per_session,
        adminNote: student.admin_note,
      },
      summary,
      bookletStatuses,
      pendingBooklets: bookletStatuses.filter(b => !b.isFullyPaid && !b.isDelivered),
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
    // معالجة مدفوعات البوكليتس
    if (req.body.booklet_payments && req.body.booklet_payments.length > 0) {
      await processBookletPayments(student.id, req.body.booklet_payments, req.session.userId);
    }

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
    // الحدود الثابتة للتنبيهات
    const THRESHOLDS = {
      absent_sessions: 2,        // غياب في حصتين متتاليتين
      poor_homework_sessions: 2, // واجبات ضعيفة في حصتين
      exam_final_attempts: 3,    // امتحان لم يُصحح في 3 محاولات
      low_balance: 100,          // رصيد منخفض (ج)
      active_warnings: 2,        // عدد التنبيهات المعلقة
      low_exam_score: 50,        // علامة امتحان منخفضة (%)
    };

    const students = await Student.findAll({
      include: [Center, Subject],
      attributes: ['id', 'name', 'student_code', 'balance', 'price_per_session', 'CenterId', 'SubjectId'],
    });

    // جلب كل البيانات مرة واحدة
    const allAttendance = await Attendance.findAll({
      include: [{ model: Session, attributes: ['lesson_number', 'SubjectId', 'status'] }],
      attributes: ['StudentId', 'SessionId', 'createdAt'],
    });
    const allHomework = await HomeworkCheck.findAll({
      attributes: ['StudentId', 'SessionId', 'status'],
    });
    const allExamResults = await ExamResult.findAll({
  include: [{ 
    model: Exam, 
    attributes: ['id', 'max_score'],
    include: [{ 
      model: Session, 
      attributes: ['lesson_number', 'SubjectId']
    }]
  }],
  attributes: ['StudentId', 'score', 'createdAt', 'ExamId'],
});
    const allWarnings = await Warning.findAll({
      attributes: ['StudentId', 'reason', 'createdAt'],
    });
    const allSessions = await Session.findAll({ attributes: ['id', 'lesson_number', 'SubjectId', 'CenterId', 'status'] });

    // تنظيم البيانات في Maps
    const attendanceByStudent = {};
    allAttendance.forEach(a => {
      if (!attendanceByStudent[a.StudentId]) attendanceByStudent[a.StudentId] = [];
      attendanceByStudent[a.StudentId].push(a);
    });

    const homeworkByKey = {};
    allHomework.forEach(h => { homeworkByKey[`${h.StudentId}_${h.SessionId}`] = h.status; });

    const examResultsByStudent = {};
    allExamResults.forEach(e => {
      if (!examResultsByStudent[e.StudentId]) examResultsByStudent[e.StudentId] = [];
      examResultsByStudent[e.StudentId].push(e);
    });

    const warningsByStudent = {};
    allWarnings.forEach(w => {
      if (!warningsByStudent[w.StudentId]) warningsByStudent[w.StudentId] = [];
      warningsByStudent[w.StudentId].push(w);
    });

    const result = [];
    for (const student of students) {
      let riskScore = 0;
      const reasons = [];
      const flags = {};

      // 1️⃣ فحص الرصيد المنخفض
      if (student.balance < THRESHOLDS.low_balance) {
        reasons.push(`💳 رصيد منخفض: ${student.balance} ج`);
        flags.lowBalance = true;
        riskScore += 15;
      }

      // 2️⃣ فحص الغياب في آخر حصتين
      const ownGroupSessions = allSessions
        .filter(sess => sess.CenterId === student.CenterId && sess.SubjectId === student.SubjectId && sess.status === 'normal')
        .sort((a, b) => b.lesson_number - a.lesson_number)
        .slice(0, 2);

      const studentAttendance = (attendanceByStudent[student.id] || [])
        .filter(a => a.Session.SubjectId === student.SubjectId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      const attendedLessonNumbers = new Set(studentAttendance.map(a => a.Session.lesson_number));
      const absentInLast2 = ownGroupSessions.filter(gs => !attendedLessonNumbers.has(gs.lesson_number)).length;

      if (ownGroupSessions.length >= 2 && absentInLast2 === 2) {
        reasons.push(`🔴 غياب في آخر ${THRESHOLDS.absent_sessions} حصص`);
        flags.absentSessions = true;
        riskScore += 30;
      } else if (absentInLast2 === 1) {
        reasons.push(`🟡 غياب في حصة واحدة من آخر حصتين`);
        flags.absentSessions = 'warning';
        riskScore += 15;
      }

      // 3️⃣ فحص جودة الواجبات
      const recentAttendance = studentAttendance.slice(0, 3);
      let poorHomeworkCount = 0;
      const homeworkStatuses = [];
      recentAttendance.forEach(att => {
        const status = homeworkByKey[`${student.id}_${att.SessionId}`];
        homeworkStatuses.push(status);
        if (!status || status === 'not_done' || status === 'incomplete' || status === 'no_steps') {
          poorHomeworkCount++;
        }
      });

      if (poorHomeworkCount >= THRESHOLDS.poor_homework_sessions) {
        reasons.push(`🟠 واجبات ضعيفة في ${poorHomeworkCount} من آخر حصص`);
        flags.poorHomework = true;
        riskScore += 25;
      } else if (poorHomeworkCount >= 1) {
        reasons.push(`🟡 واجب واحد ضعيف في آخر حصص`);
        flags.poorHomework = 'warning';
        riskScore += 10;
      }

      // 4️⃣ فحص الامتحانات غير المصححة
      const studentExams = (examResultsByStudent[student.id] || [])
        .filter(e => e.Exam && e.Exam.Session && e.Exam.Session.SubjectId === student.SubjectId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      const unfinalizedExams = studentExams.filter(e => !e.Exam.status || e.Exam.status !== 'finalized').length;
      if (unfinalizedExams >= THRESHOLDS.exam_final_attempts) {
        reasons.push(`📝 ${unfinalizedExams} امتحانات لم تُصحح بعد`);
        flags.unfinalizedExams = true;
        riskScore += 20;
      }

      // 5️⃣ فحص علامات الامتحانات المنخفضة
      const lowScoreExams = studentExams.filter(e => {
        const percentage = (e.score / e.Exam.max_score) * 100;
        return percentage < THRESHOLDS.low_exam_score;
      }).length;
      if (lowScoreExams >= 2) {
        reasons.push(`📊 ${lowScoreExams} امتحانات برتب منخفضة (أقل من 50%)`);
        flags.lowExamScores = true;
        riskScore += 20;
      }

      // 6️⃣ فحص التنبيهات المعلقة
      const activeWarnings = (warningsByStudent[student.id] || [])
        .filter(w => {
          const daysSince = (Date.now() - new Date(w.createdAt)) / (1000 * 60 * 60 * 24);
          return daysSince < 30; // تنبيهات في آخر 30 يوم
        });

      if (activeWarnings.length >= THRESHOLDS.active_warnings) {
        reasons.push(`⚠️ ${activeWarnings.length} تنبيهات معلقة`);
        flags.warnings = true;
        riskScore += 25;
      }

      // تحديد مستوى الخطورة
      let severity = 'safe';
      if (riskScore >= 75) severity = 'critical';
      else if (riskScore >= 50) severity = 'warning';
      else if (riskScore >= 25) severity = 'caution';

      // إضافة بيانات إحصائية
      const statistics = {
        attendanceRate: ownGroupSessions.length > 0 ? Math.round(((ownGroupSessions.length - absentInLast2) / ownGroupSessions.length) * 100) : 0,
        homeworkQuality: recentAttendance.length > 0 ? Math.round(((recentAttendance.length - poorHomeworkCount) / recentAttendance.length) * 100) : 0,
        averageExamScore: studentExams.length > 0 
          ? Math.round((studentExams.reduce((sum, e) => sum + e.score, 0) / studentExams.length / (studentExams[0]?.Exam?.max_score || 100)) * 100)
          : 0,
        recentExams: studentExams.slice(0, 3).map(e => ({
  lesson: e.Exam.Session?.lesson_number || 'N/A',
  score: e.score,
  maxScore: e.Exam.max_score,
  percentage: Math.round((e.score / e.Exam.max_score) * 100),
})),
      };

      if (reasons.length > 0) {
        result.push({
          student,
          reasons,
          severity,
          riskScore,
          flags,
          statistics,
          warnings: activeWarnings,
          lastAttendance: studentAttendance.length > 0 ? new Date(studentAttendance[0].createdAt).toLocaleDateString('ar-EG') : 'لا توجد',
        });
      }
    }

    // ترتيب حسب مستوى الخطورة
    const severityOrder = { critical: 0, warning: 1, caution: 2, safe: 3 };
    result.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.riskScore - a.riskScore);

    res.render('follow-up', { result, thresholds: THRESHOLDS });
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

const PaymentVerification = require('./models/PaymentVerification');

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

require('./routes/PaymentVerification')(app, {
  Student, BalanceTransaction, PaymentVerification, verifyPortalToken, sequelize,
});

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

  const transactions = await BalanceTransaction.findAll({
    where: { StudentId: student.id },
    order: [['createdAt', 'DESC']],
    limit: 30,
  });

  const ownSessionByLesson = {};
  ownSessions.forEach(s => { ownSessionByLesson[s.lesson_number] = s; });

  // حساب إحصائيات الامتحانات مرة واحدة لكل الحصص
  const examStatsMap = {};
  for (const lessonNum of lessonNumbers) {
    const att = attendanceByLesson[lessonNum];
    if (!att) continue;
    const exam = await Exam.findOne({ where: { SessionId: att.Session?.id || att.SessionId } });
    if (!exam) continue;
    const allResults = await ExamResult.findAll({ where: { ExamId: exam.id }, attributes: ['score'] });
    if (allResults.length === 0) continue;
    const scores = allResults.map(r => parseFloat(r.score));
    examStatsMap[lessonNum] = {
      max: Math.max(...scores),
      min: Math.min(...scores),
      avg: (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1),
    };
  }

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
      examStats: examStatsMap[lessonNumber] || null,
      examUser: exam ? (exam.User ? exam.User.name : null) : null,
      examTime: exam ? exam.createdAt : null,
      points: student.points || 0,
      pointsHistory: transactions
      .filter(t => t.reason && t.reason.startsWith('نقاط:'))
      .slice(0, 20)
      .map(t => ({ reason: t.reason.replace('نقاط: ', ''), amount: t.amount, time: t.createdAt })),
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
      points: student.points || 0,

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
// ===== نظام أكواد الشحن =====

// صفحة إدارة الأكواد (أدمن بس)
app.get('/admin/recharge-codes', requireAdmin, async (req, res) => {
  try {
    const codes = await RechargeCode.findAll({ order: [['createdAt', 'DESC']], limit: 100 });
    res.render('recharge-codes', { codes });
  } catch (error) {
    console.error('Failed to load recharge codes page:', error);
    res.status(500).send('حصلت مشكلة أثناء تحميل صفحة أكواد الشحن: ' + error.message);
  }
});

// توليد أكواد جديدة
app.post('/admin/recharge-codes/generate', requireAdmin, async (req, res) => {
  try {
    const { amount, count } = req.body;
    if (!amount || !count || count > 500) return res.status(400).send('❌ بيانات غير صحيحة');

    const generated = [];
    for (let i = 0; i < parseInt(count); i++) {
      const code = crypto.randomBytes(6).toString('hex').toUpperCase(); // كود 12 حرف
      await RechargeCode.create({ code, amount: parseFloat(amount) });
      generated.push({ code, amount });
    }

    // تصدير Excel
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('أكواد الشحن');
    sheet.columns = [
      { header: 'الكود', key: 'code', width: 20 },
      { header: 'القيمة (ج)', key: 'amount', width: 15 },
    ];
    generated.forEach(c => sheet.addRow(c));
    sheet.getRow(1).font = { bold: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=recharge_codes_${Date.now()}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});

// API استخدام كود الشحن (من البوابة)
app.post('/api/portal/recharge', verifyPortalToken('student'), async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.json({ success: false, message: 'ادخل الكود الأول' });

    const rechargeCode = await RechargeCode.findOne({ where: { code: code.trim().toUpperCase(), is_used: false } });
    if (!rechargeCode) return res.json({ success: false, message: '❌ الكود غير صحيح أو تم استخدامه من قبل' });

    const student = await Student.findByPk(req.portalStudentId);
    student.balance += rechargeCode.amount;
    await student.save();

    await BalanceTransaction.create({
      StudentId: student.id,
      amount: rechargeCode.amount,
      reason: `شحن رصيد بكود (${rechargeCode.code})`,
    });

    // مسح الكود بعد الاستخدام
    await RechargeCode.destroy({ where: { id: rechargeCode.id } });

    res.json({ success: true, message: `✅ تم شحن ${rechargeCode.amount} ج بنجاح!`, newBalance: student.balance });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

// ===== نظام الواجب الأونلاين (مستقل تماماً) =====

const HomeworkAssignment = require('./models/HomeworkAssignment');
const HomeworkSubmission = require('./models/HomeworkSubmission');

// Multer لرفع صور الواجبات
const hwStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads', 'homework');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}_${file.originalname}`);
  },
});
const hwUpload = multer({ storage: hwStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// sync الجداول الجديدة
HomeworkAssignment.belongsTo(require('./models/Subject'), { foreignKey: 'SubjectId' });
HomeworkAssignment.belongsTo(require('./models/Session'), { foreignKey: 'SessionId' });
HomeworkSubmission.belongsTo(HomeworkAssignment);
HomeworkSubmission.belongsTo(require('./models/Student'), { foreignKey: 'StudentId' });
HomeworkAssignment.hasMany(HomeworkSubmission);

sequelize.sync({ alter: false }).catch(() => {});

// --- صفحة إدارة الواجبات (لوحة التحكم) ---

app.get('/hw/assignments', requirePermission('homework_scan'), async (req, res) => {
  const assignments = await HomeworkAssignment.findAll({
    include: [
      { model: require('./models/Subject'), required: false },
      { model: require('./models/Session'), required: false },
    ],
    order: [['order_number', 'ASC']],
  });
  const subjects = await Subject.findAll();
  const sessions = await Session.findAll({ include: [Center, Subject], order: [['lesson_number', 'ASC']], limit: 100 });
  res.render('hw-assignments', { assignments, subjects, sessions });
});

app.post('/hw/assignments/create', requirePermission('homework_scan'), async (req, res) => {
  try {
    const { title, description, order_number, start_date, end_date, subject_id, session_id } = req.body;
    await HomeworkAssignment.create({
      title, description, order_number,
      start_date, end_date,
      SubjectId: subject_id || null,
      SessionId: session_id || null,
    });
    res.redirect('/hw/assignments');
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

app.post('/hw/assignments/:id/delete', requireAdmin, async (req, res) => {
  await HomeworkSubmission.destroy({ where: { HomeworkAssignmentId: req.params.id } });
  await HomeworkAssignment.destroy({ where: { id: req.params.id } });
  res.redirect('/hw/assignments');
});

// --- صفحة تفاصيل واجب (الطلاب الي سلموا + الي مسلموش) ---

app.get('/hw/assignments/:id', requirePermission('homework_scan'), async (req, res) => {
  const assignment = await HomeworkAssignment.findByPk(req.params.id, {
    include: [
      { model: require('./models/Subject'), required: false },
      { model: require('./models/Session'), required: false },
    ],
  });
  if (!assignment) return res.status(404).send('❌ غير موجود');

  const submissions = await HomeworkSubmission.findAll({
    where: { HomeworkAssignmentId: req.params.id },
    include: [{ model: Student, include: [Center, Subject] }],
  });

  // الطلاب اللي مسلموش ومصححوش في السنتر
  let notSubmittedAndNotGraded = [];
  if (assignment.SubjectId) {
    const allStudents = await Student.findAll({ where: { SubjectId: assignment.SubjectId }, include: [Center] });
    const submittedStudentIds = submissions.map(s => s.StudentId);

    for (const student of allStudents) {
      if (submittedStudentIds.includes(student.id)) continue;
      // تحقق من حالة الواجب في السنتر
      let hwStatus = null;
      if (assignment.SessionId) {
        const hw = await HomeworkCheck.findOne({ where: { StudentId: student.id, SessionId: assignment.SessionId } });
        hwStatus = hw ? hw.status : null;
      }
      if (!hwStatus) notSubmittedAndNotGraded.push(student);
    }
  }

  res.render('hw-assignment-detail', { assignment, submissions, notSubmittedAndNotGraded });
});

// --- تصحيح الواجب ---

app.post('/hw/submissions/:id/grade', requirePermission('homework_scan'), async (req, res) => {
  try {
    const { status, assignment_id } = req.body;
    const submission = await HomeworkSubmission.findByPk(req.params.id, { include: [Student] });
    if (!submission) return res.status(404).send('❌');

    const statusOrder = { not_done: 0, no_steps: 1, incomplete: 2, complete: 3, submitted: 1 };

    // تحديث في HomeworkCheck لو في session مرتبطة
    const assignment = await HomeworkAssignment.findByPk(assignment_id);
    if (assignment && assignment.SessionId) {
      const [check] = await HomeworkCheck.findOrCreate({
        where: { StudentId: submission.StudentId, SessionId: assignment.SessionId },
        defaults: { status, UserId: req.session.userId },
      });
      if (statusOrder[status] >= statusOrder[check.status]) {
        check.status = status;
        check.UserId = req.session.userId;
        await check.save();
      }
    }

    submission.status = status;
    submission.graded_by = req.session.userId;
    submission.graded_at = new Date();
    await submission.save();

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- API البوابة: قائمة الواجبات للطالب ---

app.get('/api/portal/homework', verifyPortalToken('student'), async (req, res) => {
  try {
    const student = await Student.findByPk(req.portalStudentId);
    const assignments = await HomeworkAssignment.findAll({
      where: { SubjectId: student.SubjectId },
      order: [['order_number', 'ASC']],
    });

    const result = await Promise.all(assignments.map(async a => {
      const submission = await HomeworkSubmission.findOne({
        where: { HomeworkAssignmentId: a.id, StudentId: student.id },
      });

      // حالة في السنتر
      let centerStatus = null;
      if (a.SessionId) {
        const hw = await HomeworkCheck.findOne({ where: { StudentId: student.id, SessionId: a.SessionId } });
        centerStatus = hw ? hw.status : null;
      }

      return {
        id: a.id,
        title: a.title,
        description: a.description,
        orderNumber: a.order_number,
        startDate: a.start_date,
        endDate: a.end_date,
        submitted: !!submission,
        submissionStatus: submission ? submission.status : null,
        centerStatus,
        imagesCount: submission ? JSON.parse(submission.images || '[]').length : 0,
      };
    }));

    res.json({ success: true, assignments: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false });
  }
});

// --- API البوابة: رفع واجب من الطالب ---

app.post('/api/portal/homework/:id/submit', verifyPortalToken('student'), async (req, res) => {
  try {
    const student = await Student.findByPk(req.portalStudentId);
    const assignment = await HomeworkAssignment.findByPk(req.params.id);
    if (!assignment) return res.status(404).json({ success: false, message: 'الواجب غير موجود' });

    const today = new Date().toISOString().slice(0, 10);
    if (today > assignment.end_date) return res.json({ success: false, message: '⚠️ انتهى وقت التسليم' });

    // بنستقبل المسارات بس (مش ملفات) - الصور اتخزنت على Hostinger بالفعل
    const { imagePaths, comment } = req.body;
    if (!imagePaths || imagePaths.length === 0) {
      return res.json({ success: false, message: 'مفيش صور مرفوعة' });
    }

    const existing = await HomeworkSubmission.findOne({
      where: { HomeworkAssignmentId: req.params.id, StudentId: student.id },
    });

    if (existing) {
      const oldPaths = JSON.parse(existing.images || '[]');
      existing.images = JSON.stringify([...oldPaths, ...imagePaths]);
      existing.student_comment = comment || existing.student_comment;
      existing.status = 'submitted';
      await existing.save();
    } else {
      await HomeworkSubmission.create({
        HomeworkAssignmentId: req.params.id,
        StudentId: student.id,
        images: JSON.stringify(imagePaths),
        student_comment: comment || null,
        status: 'submitted',
      });
    }

    res.json({ success: true, message: '✅ تم رفع الواجب بنجاح!' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ===== نظام الجدول الزمني والداشبورد التحليلي (مستقل تماماً) =====

const ScheduleEntry = require('./models/ScheduleEntry');
const Expense = require('./models/Expense');
const Salary = require('./models/Salary');

ScheduleEntry.belongsTo(Subject, { foreignKey: 'SubjectId' });
ScheduleEntry.belongsTo(Center, { foreignKey: 'CenterId' });
Salary.belongsTo(User, { foreignKey: 'UserId' });

// ===== صفحة الجدول الأسبوعي =====

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

app.get('/schedule', requirePermission('sessions_view'), async (req, res) => {
  try {
    // First try to fetch with eager loading
    let entries = [];
    try {
      entries = await ScheduleEntry.findAll({
        where: { is_active: true },
        include: [
          { model: Subject, required: false },
          { model: Center, required: false }
        ],
        order: [['day_of_week', 'ASC'], ['start_time', 'ASC']],
      });
    } catch (includeError) {
      console.warn('Eager loading failed, trying manual association:', includeError.message);
      
      // Fallback: fetch entries separately and manually associate
      entries = await ScheduleEntry.findAll({
        where: { is_active: true },
        order: [['day_of_week', 'ASC'], ['start_time', 'ASC']],
      });
      
      // Manually load associations
      for (let entry of entries) {
        try {
          entry.Subject = await Subject.findByPk(entry.SubjectId);
          entry.Center = await Center.findByPk(entry.CenterId);
        } catch (e) {
          console.error(`Failed to load associations for entry ${entry.id}:`, e.message);
        }
      }
    }

    const todayDay = new Date().getDay();
    const todayEntries = entries.filter(e => e && e.day_of_week === todayDay && e.Subject && e.Center);
    const subjects = await Subject.findAll() || [];
    const centers = await Center.findAll() || [];

    // تنظيم الجدول في grid أسبوعي
    const weekGrid = {};
    for (let i = 0; i < 7; i++) {
      weekGrid[i] = entries.filter(e => e && e.day_of_week === i && e.Subject && e.Center);
    }

    res.render('schedule', { 
      entries: entries.filter(e => e && e.Subject && e.Center), 
      todayEntries, 
      weekGrid, 
      DAYS, 
      subjects, 
      centers, 
      todayDay
      // userName, userRole, userPermissions are automatically available via res.locals middleware
    });
  } catch (e) {
    console.error('Schedule GET error:', e);
    res.status(500).send('❌ حدث خطأ في تحميل الجدول: ' + e.message);
  }
});

app.post('/schedule/add', requireAdmin, async (req, res) => {
  try {
    const { day_of_week, start_time, duration_minutes, subject_id, center_id, expected_sessions_count, end_date, notes } = req.body;
    
    // Validate required fields
    if (!day_of_week || !start_time || !subject_id || !center_id) {
      return res.status(400).send('❌ الحقول المطلوبة: اليوم، الوقت، المادة، السنتر');
    }

    // Convert form string data to proper types
    const dayOfWeek = parseInt(day_of_week, 10);
    const durationMins = parseInt(duration_minutes, 10) || 90;
    const subjectId = parseInt(subject_id, 10);
    const centerId = parseInt(center_id, 10);
    const expectedSessions = expected_sessions_count ? parseInt(expected_sessions_count, 10) : null;

    // Validate day is in range 0-6
    if (isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      return res.status(400).send('❌ اليوم غير صحيح');
    }

    // Validate time format HH:MM
    if (!/^\d{2}:\d{2}$/.test(start_time.trim())) {
      return res.status(400).send('❌ صيغة الوقت غير صحيحة (يجب أن تكون HH:MM)');
    }

    // Verify subject and center exist
    const subject = await Subject.findByPk(subjectId);
    const center = await Center.findByPk(centerId);
    if (!subject) {
      return res.status(400).send('❌ المادة غير موجودة');
    }
    if (!center) {
      return res.status(400).send('❌ السنتر غير موجود');
    }

    // Verify end_date is valid if provided
    let validEndDate = null;
    if (end_date && end_date.trim()) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(end_date.trim())) {
        return res.status(400).send('❌ صيغة التاريخ غير صحيحة (يجب أن تكون YYYY-MM-DD)');
      }
      validEndDate = end_date.trim();
    }

    await ScheduleEntry.create({
      day_of_week: dayOfWeek,
      start_time: start_time.trim(),
      duration_minutes: durationMins,
      SubjectId: subjectId,
      CenterId: centerId,
      expected_sessions_count: expectedSessions,
      end_date: validEndDate,
      notes: notes && notes.trim() ? notes.trim() : null,
    });
    
    res.redirect('/schedule');
  } catch (e) {
    console.error('Schedule add error:', e);
    res.status(500).send('❌ خطأ: ' + (e.message || 'فشل إنشاء الجدول'));
  }
});

app.post('/schedule/:id/delete', requireAdmin, async (req, res) => {
  try {
    const result = await ScheduleEntry.destroy({ where: { id: req.params.id } });
    if (!result) {
      return res.status(404).send('❌ الحصة غير موجودة');
    }
    res.redirect('/schedule');
  } catch (e) {
    console.error('Schedule delete error:', e);
    res.status(500).send('❌ ' + e.message);
  }
});

app.post('/schedule/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const entry = await ScheduleEntry.findByPk(req.params.id);
    if (!entry) {
      return res.status(404).send('❌ الحصة غير موجودة');
    }
    entry.is_active = !entry.is_active;
    await entry.save();
    res.redirect('/schedule');
  } catch (e) {
    console.error('Schedule toggle error:', e);
    res.status(500).send('❌ ' + e.message);
  }
});

// تفعيل حصة من الجدول مباشرة
app.post('/schedule/:id/start-session', requirePermission('sessions_create'), async (req, res) => {
  try {
    const entry = await ScheduleEntry.findByPk(req.params.id, { include: [Subject, Center] });
    if (!entry) return res.status(404).send('❌');

    const series = await CenterSubjectSeries.findOne({ where: { CenterId: entry.CenterId, SubjectId: entry.SubjectId } });
    if (!series) return res.status(400).send('❌ مفيش أساس سيريال');

    const lastSession = await Session.findOne({ where: { SubjectId: entry.SubjectId }, order: [['lesson_number', 'DESC']] });
    const finalLessonNumber = lastSession ? lastSession.lesson_number + 1 : 1;
    const serialNumber = series.base_number + finalLessonNumber;

    const newSession = await Session.create({
      lesson_number: finalLessonNumber,
      serial_number: serialNumber,
      CenterId: entry.CenterId,
      SubjectId: entry.SubjectId,
    });

    req.session.activeSessionId = newSession.id;
    res.redirect('/sessions');
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// Cron: تفعيل الحصص تلقائياً بالوقت المحدد
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const currentDay = now.getDay();
    const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:00`;

    const entries = await ScheduleEntry.findAll({
      where: { day_of_week: currentDay, start_time: currentTime, is_active: true },
    });

    for (const entry of entries) {
      const series = await CenterSubjectSeries.findOne({ where: { CenterId: entry.CenterId, SubjectId: entry.SubjectId } });
      if (!series) continue;

      const lastSession = await Session.findOne({ where: { SubjectId: entry.SubjectId }, order: [['lesson_number', 'DESC']] });
      const finalLessonNumber = lastSession ? lastSession.lesson_number + 1 : 1;
      const serialNumber = series.base_number + finalLessonNumber;

      await Session.create({
        lesson_number: finalLessonNumber, serial_number: serialNumber,
        CenterId: entry.CenterId, SubjectId: entry.SubjectId,
      });

      console.log(`✅ تم تفعيل حصة تلقائياً: مادة ${entry.SubjectId} - سنتر ${entry.CenterId}`);
    }
  } catch (e) {
    console.error('Cron schedule error:', e.message);
  }
});

// ===== الداشبورد التحليلي (محمي بباسورد) =====

app.get('/analytics/lock', requireAdmin, (req, res) => {
  res.render('analytics-lock', { error: null });
});

app.post('/analytics/unlock', requireAdmin, async (req, res) => {
  const adminUser = await User.findByPk(req.session.userId);
  const match = await bcrypt.compare(req.body.password, adminUser.password);
  if (!match) return res.render('analytics-lock', { error: 'كلمة المرور غير صحيحة' });
  req.session.analyticsUnlocked = true;
  res.redirect('/analytics');
});

function requireAnalyticsAuth(req, res, next) {
  if (req.session.userRole !== 'admin') return res.status(403).send('⛔');
  if (req.session.analyticsUnlocked) return next();
  res.redirect('/analytics/lock');
}

app.get('/analytics', requireAnalyticsAuth, async (req, res) => {
  const { month, compare_month, subject_id, center_id } = req.query;
  const currentMonth = month || new Date().toISOString().slice(0, 7);
  const compareMonth = compare_month || null;

  const subjects = await Subject.findAll();
  const centers = await Center.findAll();
  const users = await User.findAll();

  const monthStart = currentMonth + '-01';
  const monthEnd = currentMonth + '-31';

  // ===== دالة مساعدة لحساب إحصائيات مجموعة معينة =====
  async function calcGroupStats(subj, cent, fromDate, toDate) {
    const groupStudents = await Student.findAll({
      where: { SubjectId: subj.id, CenterId: cent.id },
      include: [Center, Subject],
    });
    if (groupStudents.length === 0) return null;

    const groupSessions = await Session.findAll({
      where: { SubjectId: subj.id, CenterId: cent.id, status: 'normal',
        ...(fromDate && toDate ? { session_date: { [Op.between]: [fromDate, toDate] } } : {}),
      },
    });

    const studentIds = groupStudents.map(s => s.id);
    const sessionIds = groupSessions.map(s => s.id);

    // حضور
    const allAttendances = await Attendance.findAll({
      where: { SessionId: sessionIds },
      include: [{ model: Student, required: false }],
    });
    const ownAttendances = allAttendances.filter(a => studentIds.includes(a.StudentId));
    const outsideAttendances = allAttendances.filter(a => !studentIds.includes(a.StudentId));

    // تعويض أونلاين
    const onlineCompensation = await Attendance.findAll({
      where: { StudentId: studentIds },
      include: [{ model: Session, include: [Center], where: { SubjectId: subj.id } }],
    });
    const onlineComp = onlineCompensation.filter(a => a.Session.Center.name === 'أونلاين').length;
    const otherCenterComp = onlineCompensation.filter(a =>
      a.Session.CenterId !== cent.id && a.Session.Center.name !== 'أونلاين'
    ).length;

    // واجب
    const hwRecords = await HomeworkCheck.findAll({
      where: { StudentId: studentIds, SessionId: sessionIds },
    });
    const hwStats = {
      complete: hwRecords.filter(h => h.status === 'complete').length,
      incomplete: hwRecords.filter(h => h.status === 'incomplete').length,
      no_steps: hwRecords.filter(h => h.status === 'no_steps').length,
      not_done: hwRecords.filter(h => h.status === 'not_done').length,
    };

    // امتحانات
    const examResults = await ExamResult.findAll({
      where: { StudentId: studentIds },
      include: [{ model: Exam, where: { SubjectId: subj.id }, required: false }],
    });
    const validScores = examResults.filter(r => r.Exam).map(r => ({ score: r.score, max: r.Exam.max_score }));
    const avgScore = validScores.length > 0
      ? (validScores.reduce((s, r) => s + (r.score / r.max * 100), 0) / validScores.length).toFixed(1)
      : null;

    // مالي
    const normalPrice = Math.max(...groupStudents.map(s => s.price_per_session));
    const reducedStudents = groupStudents.filter(s => s.price_per_session < normalPrice && s.price_per_session > 0);
    const freeStudents = groupStudents.filter(s => s.price_per_session === 0);
    const revenue = ownAttendances.reduce((sum, a) => {
      const st = groupStudents.find(s => s.id === a.StudentId);
      return sum + (st ? st.price_per_session : 0);
    }, 0);

    // نمو الطلاب
    const thirtyAgo = new Date(); thirtyAgo.setDate(thirtyAgo.getDate() - 30);
    const sixtyAgo = new Date(); sixtyAgo.setDate(sixtyAgo.getDate() - 60);
    const recentNew = groupStudents.filter(s => new Date(s.createdAt) >= thirtyAgo).length;
    const prevNew = groupStudents.filter(s => new Date(s.createdAt) >= sixtyAgo && new Date(s.createdAt) < thirtyAgo).length;
    const growthRate = prevNew > 0 ? (((recentNew - prevNew) / prevNew) * 100).toFixed(1) : (recentNew > 0 ? 100 : 0);

    // توقع الشهر الجاي
    const avgRevPerStudent = revenue / (groupStudents.length || 1);
    const projectedNext = Math.round(avgRevPerStudent * groupStudents.length * 1.05);

    const totalPossible = groupStudents.length * groupSessions.length;
    const attendanceRate = totalPossible > 0 ? ((ownAttendances.length / totalPossible) * 100).toFixed(1) : 0;
    const hwRate = hwRecords.length > 0 ? ((hwStats.complete / hwRecords.length) * 100).toFixed(1) : 0;

    // تنبيهات
    const alerts = [];
    if (parseFloat(attendanceRate) < 60) alerts.push({ type: 'danger', msg: `نسبة حضور منخفضة جداً (${attendanceRate}%)` });
    else if (parseFloat(attendanceRate) < 75) alerts.push({ type: 'warning', msg: `نسبة حضور تحت المتوسط (${attendanceRate}%)` });
    if (parseFloat(growthRate) < -10) alerts.push({ type: 'danger', msg: `تراجع في عدد الطلاب (${growthRate}%)` });
    if (parseFloat(hwRate) < 50) alerts.push({ type: 'warning', msg: `نسبة إنجاز الواجب ضعيفة (${hwRate}%)` });
    if (freeStudents.length / groupStudents.length > 0.2) alerts.push({ type: 'info', msg: `نسبة الطلاب المجانيين مرتفعة (${Math.round(freeStudents.length/groupStudents.length*100)}%)` });

    return {
      subjectId: subj.id, centerId: cent.id,
      subjectName: subj.name, centerName: cent.name,
      totalStudents: groupStudents.length,
      totalSessions: groupSessions.length,
      ownAttendance: ownAttendances.length,
      outsideAttendance: outsideAttendances.length,
      onlineCompensation: onlineComp,
      otherCenterCompensation: otherCenterComp,
      attendanceRate: parseFloat(attendanceRate),
      reducedCount: reducedStudents.length,
      freeCount: freeStudents.length,
      hwStats, hwRate: parseFloat(hwRate),
      avgScore, revenue,
      growthRate: parseFloat(growthRate),
      recentNew, projectedNext,
      normalPrice, alerts,
    };
  }

  // حساب كل المجموعات
  const subjectsData = await Subject.findAll();
  const centersData = await Center.findAll();
  const groupStats = [];
  // إجمالي البوكليتس في الشهر
  const bookletSales = await BalanceTransaction.findAll({
    where: {
      reason: { [Op.like]: 'دفع بوكليت:%' },
      createdAt: { [Op.between]: [monthStart + ' 00:00:00', monthEnd + ' 23:59:59'] },
    },
  });
  const totalBookletRevenue = bookletSales.reduce((s, t) => s + t.amount, 0);

  // تكلفة البوكليتس
  const allBooklets = await Booklet.findAll({ include: [Subject] });
  const totalBookletCost = allBooklets.reduce((s, b) => s + (b.print_price * b.stock_count), 0);
  const totalBookletProfit = allBooklets.reduce((s, b) => s + ((b.sell_price - b.print_price) * b.stock_count), 0);

  for (const subj of subjectsData) {
    if (subject_id && String(subj.id) !== String(subject_id)) continue;
    for (const cent of centersData) {
      if (center_id && String(cent.id) !== String(center_id)) continue;
      const stats = await calcGroupStats(subj, cent, monthStart, monthEnd);
      if (stats) groupStats.push(stats);
    }
  }

  // مقارنة مع شهر تاني
  let compareStats = [];
  if (compareMonth) {
    const cStart = compareMonth + '-01';
    const cEnd = compareMonth + '-31';
    for (const subj of subjectsData) {
      for (const cent of centersData) {
        const stats = await calcGroupStats(subj, cent, cStart, cEnd);
        if (stats) compareStats.push({ ...stats, isCompare: true });
      }
    }
  }

  // ===== مالي الشهر =====
  const monthlyAttendances = await Attendance.findAll({
    where: { createdAt: { [Op.between]: [monthStart + ' 00:00:00', monthEnd + ' 23:59:59'] } },
    include: [{ model: Student }],
  });
  const monthlyRevenue = monthlyAttendances.reduce((s, a) => s + (a.Student ? a.Student.price_per_session : 0), 0);

  const expenses = await Expense.findAll({
    where: { expense_date: { [Op.between]: [monthStart, monthEnd] } },
    order: [['expense_date', 'DESC']],
  });
  const salaries = await Salary.findAll({ where: { month: currentMonth }, include: [User] });
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  const totalSalaries = salaries.reduce((s, e) => s + e.amount, 0);
  // راتب الأسيستانتس المحسوب من حضورهم الفعلي في الشهر
  const assistantSalariesMonth = await AssistantAttendance.findAll({
    where: {
      createdAt: { [Op.between]: [monthStart + ' 00:00:00', monthEnd + ' 23:59:59'] },
      salary_calculated: { [Op.not]: null },
    },
    include: [User],
  });
  const totalAssistantSalaries = assistantSalariesMonth.reduce((s, a) => s + (a.salary_calculated || 0), 0);

  // ===== مؤشرات شهرية تاريخية (آخر 6 شهور) =====
  const monthlyTrend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const m = d.toISOString().slice(0, 7);
    const mStart = m + '-01'; const mEnd = m + '-31';
    const mAtts = await Attendance.findAll({
      where: { createdAt: { [Op.between]: [mStart + ' 00:00:00', mEnd + ' 23:59:59'] } },
      include: [Student],
    });
    const mRevenue = mAtts.reduce((s, a) => s + (a.Student ? a.Student.price_per_session : 0), 0);
    const mStudents = await Student.count({ where: { createdAt: { [Op.lte]: mEnd + ' 23:59:59' } } });
    monthlyTrend.push({ month: m, revenue: mRevenue, students: mStudents, sessions: mAtts.length });
  }

  // ===== التنبيهات الكلية =====
  const allAlerts = groupStats.flatMap(g => g.alerts.map(a => ({ ...a, group: `${g.subjectName} - ${g.centerName}` })));

  // ===== توقع الشهر الجاي =====
  const projectedMonthly = groupStats.reduce((s, g) => s + g.projectedNext, 0);

  res.render('analytics-dashboard', {
    groupStats, compareStats, compareMonth,
    expenses, salaries, users,
    totalExpenses, totalSalaries, monthlyRevenue,
    netRevenue: monthlyRevenue - totalExpenses - totalSalaries,
    projectedMonthly, monthlyTrend, allAlerts,
    currentMonth, subjects, centers,
    filters: { subject_id, center_id, month: currentMonth, compare_month: compareMonth },
    totalAssistantSalaries,
    netRevenue: monthlyRevenue - totalExpenses - totalSalaries - totalAssistantSalaries,
    totalBookletRevenue, totalBookletCost, totalBookletProfit, allBooklets,
  });
});

// Route تفاصيل مجموعة معينة
app.get('/analytics/group/:subjectId/:centerId', requireAnalyticsAuth, async (req, res) => {
  const { subjectId, centerId } = req.params;
  const { month } = req.query;
  const currentMonth = month || new Date().toISOString().slice(0, 7);
  const monthStart = currentMonth + '-01';
  const monthEnd = currentMonth + '-31';

  const subj = await Subject.findByPk(subjectId);
  const cent = await Center.findByPk(centerId);
  if (!subj || !cent) return res.status(404).send('❌');

  const groupStudents = await Student.findAll({
    where: { SubjectId: subjectId, CenterId: centerId },
    order: [['name', 'ASC']],
  });
  const groupSessions = await Session.findAll({
    where: { SubjectId: subjectId, CenterId: centerId, status: 'normal' },
    order: [['lesson_number', 'ASC']],
  });
  const sessionIds = groupSessions.map(s => s.id);
  const studentIds = groupStudents.map(s => s.id);

  // تفاصيل كل طالب
  const studentDetails = [];
  for (const student of groupStudents) {
    const attCount = await Attendance.count({ where: { StudentId: student.id, SessionId: sessionIds } });
    const hwComplete = await HomeworkCheck.count({ where: { StudentId: student.id, SessionId: sessionIds, status: 'complete' } });
    const hwTotal = await HomeworkCheck.count({ where: { StudentId: student.id, SessionId: sessionIds } });
    const examResults = await ExamResult.findAll({ where: { StudentId: student.id }, include: [Exam] });
    const avgExam = examResults.length > 0
      ? (examResults.reduce((s, r) => s + (r.score / (r.Exam?.max_score || 100) * 100), 0) / examResults.length).toFixed(1)
      : null;

    studentDetails.push({
      id: student.id, name: student.name, code: student.student_code,
      balance: student.balance, price: student.price_per_session,
      points: student.points || 0,
      attendanceCount: attCount, totalSessions: groupSessions.length,
      attendanceRate: groupSessions.length > 0 ? ((attCount / groupSessions.length) * 100).toFixed(0) : 0,
      hwComplete, hwTotal, avgExam,
    });
  }

  // مشاهدة الحصص على مدار الوقت (chart)
  const attendanceBySession = [];
  for (const session of groupSessions.slice(-10)) {
    const count = await Attendance.count({ where: { SessionId: session.id, StudentId: studentIds } });
    const outside = await Attendance.count({ where: { SessionId: session.id, StudentId: { [Op.notIn]: studentIds } } });
    attendanceBySession.push({ lesson: session.lesson_number, own: count, outside });
  }

  res.render('analytics-group-detail', {
    subj, cent, studentDetails, groupSessions,
    attendanceBySession, currentMonth,
  });
});

// إضافة مصروف
app.post('/analytics/expense/add', requireAnalyticsAuth, async (req, res) => {
  const { amount, reason, type, expense_date } = req.body;
  await Expense.create({ amount, reason, type, expense_date });
  res.redirect('/analytics');
});

app.post('/analytics/expense/:id/delete', requireAnalyticsAuth, async (req, res) => {
  await Expense.destroy({ where: { id: req.params.id } });
  res.redirect('/analytics');
});

// إضافة مرتب
app.post('/analytics/salary/add', requireAnalyticsAuth, async (req, res) => {
  const { user_id, amount, month, notes } = req.body;
  const [sal] = await Salary.findOrCreate({
    where: { UserId: user_id, month },
    defaults: { amount, notes },
  });
  if (sal.amount !== parseFloat(amount)) { sal.amount = amount; sal.notes = notes; await sal.save(); }
  res.redirect('/analytics');
});

// ===== نظام حضور الأسيستانت (مستقل تماماً) =====

const AssistantAttendance = require('./models/AssistantAttendance');
const SalaryConfig = require('./models/SalaryConfig');

AssistantAttendance.belongsTo(User, { foreignKey: 'UserId' });
AssistantAttendance.belongsTo(Session, { foreignKey: 'SessionId' });
User.hasMany(AssistantAttendance, { foreignKey: 'UserId' });
Session.hasMany(AssistantAttendance, { foreignKey: 'SessionId' });
SalaryConfig.belongsTo(User, { foreignKey: 'UserId' });
User.hasOne(SalaryConfig, { foreignKey: 'UserId' });

// دالة مساعدة: تسجيل حضور تلقائي للأسيستانت لو عمل أي حاجة في الحصة
async function autoRegisterAssistantAttendance(userId, sessionId) {
  try {
    const existing = await AssistantAttendance.findOne({ where: { UserId: userId, SessionId: sessionId } });
    if (existing) return; // مسجل بالفعل

    const salaryConfig = await SalaryConfig.findOne({ where: { UserId: userId } });
    await AssistantAttendance.create({
      UserId: userId,
      SessionId: sessionId,
      check_in: new Date(),
      check_in_method: 'auto',
      salary_type: salaryConfig ? salaryConfig.salary_type : 'fixed',
      salary_amount: salaryConfig ? salaryConfig.base_amount : 0,
    });
  } catch (e) {
    console.error('Auto register assistant attendance error:', e.message);
  }
}

// ===== Routes =====

// تسجيل حضور يدوي للأسيستانت في حصة
app.post('/sessions/:id/assistant-attendance/add', requireAdmin, async (req, res) => {
  try {
    const { user_id, check_in, notes } = req.body;
    const salaryConfig = await SalaryConfig.findOne({ where: { UserId: user_id } });

    await AssistantAttendance.findOrCreate({
      where: { UserId: user_id, SessionId: req.params.id },
      defaults: {
        check_in: check_in ? new Date(check_in) : new Date(),
        check_in_method: 'manual',
        notes,
        salary_type: salaryConfig ? salaryConfig.salary_type : 'fixed',
        salary_amount: salaryConfig ? salaryConfig.base_amount : 0,
      },
    });

    res.redirect(`/sessions/${req.params.id}/report`);
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// تسجيل وقت الانصراف + حساب الراتب
app.post('/sessions/:sessionId/assistant-attendance/:id/checkout', requireAdmin, async (req, res) => {
  try {
    const { check_out } = req.body;
    const record = await AssistantAttendance.findByPk(req.params.id);
    if (!record) return res.status(404).send('❌');

    const checkOutTime = check_out ? new Date(check_out) : new Date();
    record.check_out = checkOutTime;
    record.check_out_method = check_out ? 'manual' : 'auto';

    if (record.check_in) {
      record.working_minutes = Math.round((checkOutTime - new Date(record.check_in)) / 60000);
    }

    // حساب الراتب
    if (record.salary_type === 'fixed') {
      record.salary_calculated = record.salary_amount;
    } else if (record.salary_type === 'hourly') {
      record.salary_calculated = (record.working_minutes / 60) * record.salary_amount;
    } else if (record.salary_type === 'per_session') {
      record.salary_calculated = record.salary_amount;
    }

    await record.save();
    res.redirect(`/sessions/${req.params.sessionId}/report`);
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// تعديل يدوي لبيانات الحضور
app.post('/sessions/:sessionId/assistant-attendance/:id/edit', requireAdmin, async (req, res) => {
  try {
    const { check_in, check_out, notes, salary_amount, salary_type } = req.body;
    const record = await AssistantAttendance.findByPk(req.params.id);
    if (!record) return res.status(404).send('❌');

    record.check_in = check_in ? new Date(check_in) : record.check_in;
    record.check_out = check_out ? new Date(check_out) : record.check_out;
    record.check_in_method = 'manual';
    record.notes = notes;
    record.salary_type = salary_type || record.salary_type;
    record.salary_amount = salary_amount || record.salary_amount;

    if (record.check_in && record.check_out) {
      record.working_minutes = Math.round((new Date(record.check_out) - new Date(record.check_in)) / 60000);
      if (record.salary_type === 'fixed') {
        record.salary_calculated = record.salary_amount;
      } else if (record.salary_type === 'hourly') {
        record.salary_calculated = (record.working_minutes / 60) * record.salary_amount;
      } else {
        record.salary_calculated = record.salary_amount;
      }
    }

    await record.save();
    res.redirect(`/sessions/${req.params.sessionId}/report`);
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// حذف سجل حضور أسيستانت
app.post('/sessions/:sessionId/assistant-attendance/:id/delete', requireAdmin, async (req, res) => {
  await AssistantAttendance.destroy({ where: { id: req.params.id } });
  res.redirect(`/sessions/${req.params.sessionId}/report`);
});

// صفحة إحصائيات الأسيستانت الموسعة (مع فلتر تواريخ)
app.get('/users/:id/stats', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  const targetUser = await User.findByPk(req.params.id);
  if (!targetUser) return res.status(404).send('❌');

  const dateFilter = from && to ? { createdAt: { [Op.between]: [from + ' 00:00:00', to + ' 23:59:59'] } } : {};

  const attendanceCount = await Attendance.count({ where: { UserId: targetUser.id, ...dateFilter } });
  const homeworkCount = await HomeworkCheck.count({ where: { UserId: targetUser.id, ...dateFilter } });
  const examResultCount = await ExamResult.count({ where: { UserId: targetUser.id, ...dateFilter } });
  const studentsRegistered = await Student.count({ where: { UserId: targetUser.id } });

  // حضور الأسيستانت للحصص
  const assistantAttFilter = from && to ? { createdAt: { [Op.between]: [from + ' 00:00:00', to + ' 23:59:59'] } } : {};
  const assistantAttendances = await AssistantAttendance.findAll({
    where: { UserId: targetUser.id, ...assistantAttFilter },
    include: [{ model: Session, include: [Center, Subject] }],
    order: [['check_in', 'DESC']],
  });

  const totalWorkingMinutes = assistantAttendances.reduce((s, a) => s + (a.working_minutes || 0), 0);
  const totalSalaryCalculated = assistantAttendances.reduce((s, a) => s + (a.salary_calculated || 0), 0);
  const sessionsAttended = assistantAttendances.length;

  // سجل اليوم الأخيرة 7 أيام
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

  // إعداد الراتب
  const salaryConfig = await SalaryConfig.findOne({ where: { UserId: targetUser.id } });

  res.render('user-stats', {
    targetUser, attendanceCount, homeworkCount, examResultCount,
    studentsRegistered, dayCounts, assistantAttendances,
    totalWorkingMinutes, totalSalaryCalculated, sessionsAttended,
    salaryConfig, filters: { from, to },
  });
});

// حفظ إعداد الراتب للأسيستانت
app.post('/users/:id/salary-config', requireAdmin, async (req, res) => {
  const { salary_type, base_amount, notes } = req.body;
  await SalaryConfig.upsert({
    UserId: req.params.id,
    salary_type, base_amount, notes,
  });
  res.redirect(`/users/${req.params.id}/stats`);
});

// تطبيق autoRegister على كل عمليات الأسيستانت
// ملاحظة: ده بيستخدم app.use عشان يكتشف تلقائياً
app.use(async (req, res, next) => {
  if (req.method === 'POST' && req.session?.userId && req.session?.userRole === 'assistant' && req.session?.activeSessionId) {
    const autoTriggers = ['/attendance/scan', '/homework/scan/save', '/exams/'];
    const shouldTrigger = autoTriggers.some(path => req.path.startsWith(path));
    if (shouldTrigger) {
      await autoRegisterAssistantAttendance(req.session.userId, req.session.activeSessionId);
    }
  }
  next();
});

// ===== نظام البوكليتس (مستقل تماماً) =====

// ===== ADMIN: إدارة البوكليتس =====

app.get('/admin/booklets', requireAdmin, async (req, res) => {
  const booklets = await Booklet.findAll({
    include: [Subject],
    order: [['SubjectId', 'ASC'], ['order_index', 'ASC']],
  });
  const subjects = await Subject.findAll();
  res.render('manage-booklets', { booklets, subjects });
});

app.post('/admin/booklets/add', requireAdmin, async (req, res) => {
  try {
    const { name, subject_id, print_price, sell_price, stock_count, order_index } = req.body;
    await Booklet.create({ name, SubjectId: subject_id, print_price, sell_price, stock_count, order_index: order_index || 1 });
    res.redirect('/admin/booklets');
  } catch (e) { console.error(e); res.status(500).send('❌ ' + e.message); }
});

app.post('/admin/booklets/:id/edit', requireAdmin, async (req, res) => {
  try {
    const { name, print_price, sell_price, stock_count, order_index, is_active } = req.body;
    await Booklet.update({
      name, print_price, sell_price, stock_count, order_index,
      is_active: is_active === 'on',
    }, { where: { id: req.params.id } });
    res.redirect('/admin/booklets');
  } catch (e) { console.error(e); res.status(500).send('❌ ' + e.message); }
});

app.post('/admin/booklets/:id/delete', requireAdmin, async (req, res) => {
  await Booklet.destroy({ where: { id: req.params.id } });
  res.redirect('/admin/booklets');
});

// ===== ADMIN: تسجيل دفع بوكليت لطالب من ملفه =====

app.post('/students/:studentId/booklet-payment', requireAdmin, async (req, res) => {
  try {
    const { booklet_id, paid_amount, notes } = req.body;
    const student = await Student.findByPk(req.params.studentId);
    const booklet = await Booklet.findByPk(booklet_id);
    if (!student || !booklet) return res.status(404).send('❌');

    const existing = await StudentBooklet.findOne({ where: { StudentId: student.id, BookletId: booklet_id } });
    if (existing) {
      existing.paid_amount += parseFloat(paid_amount);
      existing.notes = notes || existing.notes;
      await existing.save();
    } else {
      await StudentBooklet.create({ StudentId: student.id, BookletId: booklet_id, paid_amount: parseFloat(paid_amount), notes });
    }

    await BalanceTransaction.create({
      StudentId: student.id,
      amount: parseFloat(paid_amount),
      reason: `دفع بوكليت: ${booklet.name}`,
      UserId: req.session.userId,
    });

    res.redirect('/students/' + req.params.studentId);
  } catch (e) { console.error(e); res.status(500).send('❌ ' + e.message); }
});

app.post('/students/:studentId/booklet-deliver/:sbId', requireAdmin, async (req, res) => {
  const sb = await StudentBooklet.findByPk(req.params.sbId);
  if (sb) { sb.is_delivered = true; sb.delivered_at = new Date(); await sb.save(); }
  res.redirect('/students/' + req.params.studentId);
});

// ===== Lookup: جلب بيانات الطالب مع البوكليتس (للصفحة اللي تظهر بعد السكان) =====

app.post('/attendance/scan/lookup', async (req, res) => {
  try {
    const { student_code } = req.body;
    const sessionId = req.session.activeSessionId;

    const student = await Student.findOne({
      where: { student_code },
      include: [Center, Subject],
    });
    if (!student) return res.json({ success: false, message: 'كود الطالب غير صحيح' });

    if (student.is_blocked) return res.json({ success: false, message: '⛔ الطالب محظور من النظام' });

    const activeSession = await Session.findByPk(sessionId);
    if (!activeSession) return res.json({ success: false, message: '⚠️ مفيش حصة شغالة' });
    if (activeSession.status === 'cancelled') return res.json({ success: false, message: '⚠️ هذه الحصة ملغية' });

    const existing = await Attendance.findOne({ where: { StudentId: student.id, SessionId: sessionId } });
    if (existing) return res.json({ success: false, message: `${student.name} مسجل حضوره من قبل` });

    // بوكليتس المادة بتاعة الطالب
    const booklets = await Booklet.findAll({
      where: { SubjectId: student.SubjectId, is_active: true },
      order: [['order_index', 'ASC']],
    });

    const bookletStatus = await Promise.all(booklets.map(async b => {
      const sb = await StudentBooklet.findOne({ where: { StudentId: student.id, BookletId: b.id } });
      const paidAmount = sb ? sb.paid_amount : 0;
      const remaining = b.sell_price - paidAmount;
      const isDelivered = sb ? sb.is_delivered : false;
      return {
        id: b.id, name: b.name,
        sellPrice: b.sell_price,
        paidAmount, remaining,
        isDelivered,
        isFullyPaid: remaining <= 0,
      };
    }));

    const pendingBooklets = bookletStatus.filter(b => !b.isFullyPaid && !b.isDelivered);

    // حصص متابعة الطالب
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

    const videos = await Video.findAll({ where: { SubjectId: student.SubjectId }, include: [Session, VideoPart] });
    const videoBySessionId = {};
    videos.forEach(v => { videoBySessionId[v.SessionId] = v; });
    const watchRecords = await WatchProgress.findAll({ where: { StudentId: student.id } });
    const watchMap = {};
    watchRecords.forEach(w => { watchMap[w.VideoPartId] = w.watched_seconds; });
    const categoryLabels = { explanation: 'شرح', questions: 'أسئلة', homework_solution: 'حل واجب' };

    const lessonNumbersSet = new Set();
    ownSessions.forEach(s => lessonNumbersSet.add(s.lesson_number));
    Object.keys(attByLesson).forEach(n => lessonNumbersSet.add(parseInt(n)));
    const lessonNumbers = Array.from(lessonNumbersSet).sort((a, b) => a - b);

    const summary = lessonNumbers.map(lessonNumber => {
      const att = attByLesson[lessonNumber];
      let parts = [];
      if (att) {
        const video = videoBySessionId[att.id];
        if (video && video.VideoParts) {
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
        id: student.id, name: student.name,
        code: student.student_code,
        balance: student.balance,
        pricePerSession: student.price_per_session,
        adminNote: student.admin_note,
      },
      pendingBooklets,
      summary,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

// ===== تسجيل حضور مع دفع بوكليت =====

// تأكد إن route الـ /attendance/scan POST بيستقبل booklet_payments
// ضيف الكود ده بعد حفظ الـ Attendance:

async function processBookletPayments(studentId, bookletPayments, userId) {
  if (!bookletPayments) return;
  const payments = Array.isArray(bookletPayments) ? bookletPayments : [bookletPayments];
  for (const payment of payments) {
    if (!payment.booklet_id || !payment.amount || parseFloat(payment.amount) <= 0) continue;
    const booklet = await Booklet.findByPk(payment.booklet_id);
    if (!booklet) continue;

    const [sb] = await StudentBooklet.findOrCreate({
      where: { StudentId: studentId, BookletId: payment.booklet_id },
      defaults: { paid_amount: 0 },
    });
    sb.paid_amount += parseFloat(payment.amount);
    await sb.save();

    await BalanceTransaction.create({
      StudentId: studentId,
      amount: parseFloat(payment.amount),
      reason: `دفع بوكليت: ${booklet.name}`,
      UserId: userId,
    });
  }
}

// ===== ADMIN: صفحة مراجعة المدفوعات والحجوزات =====

app.get('/admin/payment-verifications', requireAdmin, async (req, res) => {
  const { status, from, to, tab } = req.query;
  const currentTab = tab || 'reservations';

  const whereClause = {};
  if (status) whereClause.status = status;
  if (from && to) whereClause.createdAt = { [Op.between]: [from + ' 00:00:00', to + ' 23:59:59'] };

  const reservations = await BookletReservation.findAll({
    where: whereClause,
    include: [
      { model: Student, include: [Subject, Center] },
      { model: Booklet },
    ],
    order: [['createdAt', 'DESC']],
  });

  res.render('payment-verifications', { reservations, currentTab, filters: { status, from, to } });
});

app.post('/admin/payment-verifications/:id/verify', requireAdmin, async (req, res) => {
  try {
    const { paid_amount, notes } = req.body;
    const reservation = await BookletReservation.findByPk(req.params.id, { include: [Student, Booklet] });
    if (!reservation) return res.status(404).send('❌');

    reservation.status = 'verified';
    reservation.paid_amount = parseFloat(paid_amount) || reservation.Booklet.sell_price;
    reservation.verified_by = req.session.userId;
    reservation.notes = notes;
    await reservation.save();

    // تسجيل الدفع في StudentBooklet
    const [sb] = await StudentBooklet.findOrCreate({
      where: { StudentId: reservation.StudentId, BookletId: reservation.BookletId },
      defaults: { paid_amount: 0 },
    });
    sb.paid_amount += reservation.paid_amount;
    await sb.save();

    await BalanceTransaction.create({
      StudentId: reservation.StudentId,
      amount: reservation.paid_amount,
      reason: `حجز بوكليت محقق: ${reservation.Booklet.name}`,
      UserId: req.session.userId,
    });

    res.redirect('/admin/payment-verifications?tab=reservations');
  } catch (e) { console.error(e); res.status(500).send('❌ ' + e.message); }
});

app.post('/admin/payment-verifications/:id/reject', requireAdmin, async (req, res) => {
  await BookletReservation.update({ status: 'rejected' }, { where: { id: req.params.id } });
  res.redirect('/admin/payment-verifications?tab=reservations');
});

app.post('/admin/payment-verifications/:id/deliver', requireAdmin, async (req, res) => {
  const r = await BookletReservation.findByPk(req.params.id);
  if (r) { r.is_delivered = true; r.delivered_at = new Date(); await r.save(); }
  res.redirect('/admin/payment-verifications?tab=reservations');
});

// ===== API البوابة: قائمة البوكليتس للطالب =====

app.get('/api/portal/booklets', verifyPortalToken('student'), async (req, res) => {
  try {
    const student = await Student.findByPk(req.portalStudentId);
    const booklets = await Booklet.findAll({
      where: { SubjectId: student.SubjectId, is_active: true },
      order: [['order_index', 'ASC']],
    });

    const result = await Promise.all(booklets.map(async b => {
      const sb = await StudentBooklet.findOne({ where: { StudentId: student.id, BookletId: b.id } });
      const reservation = await BookletReservation.findOne({
        where: { StudentId: student.id, BookletId: b.id, status: { [Op.ne]: 'rejected' } },
      });
      return {
        id: b.id, name: b.name, sellPrice: b.sell_price,
        paidAmount: sb ? sb.paid_amount : 0,
        remaining: b.sell_price - (sb ? sb.paid_amount : 0),
        isDelivered: sb ? sb.is_delivered : false,
        reservation: reservation ? { status: reservation.status, method: reservation.payment_method, isDelivered: reservation.is_delivered } : null,
      };
    }));

    res.json({ success: true, booklets: result });
  } catch (e) { console.error(e); res.status(500).json({ success: false }); }
});

// ===== API البوابة: حجز بوكليت =====

const reservationUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/portal/booklets/:id/reserve', verifyPortalToken('student'), reservationUpload.single('transfer_image'), async (req, res) => {
  try {
    const { payment_method } = req.body;
    await ensureBookletReservationSchema(sequelize);
    const student = await Student.findByPk(req.portalStudentId);
    const booklet = await Booklet.findByPk(req.params.id);
    if (!booklet) return res.status(404).json({ success: false, message: 'البوكليت غير موجود' });

    // تحقق مفيش حجز موجود
    const existing = await BookletReservation.findOne({
      where: { StudentId: student.id, BookletId: booklet.id, status: { [Op.ne]: 'rejected' } },
    });
    if (existing) return res.json({ success: false, message: 'عندك حجز موجود بالفعل لهذا البوكليت' });

    let transferImageUrl = null;
    let transactionReference = null;

    // رفع الصورة على Cloudinary لو فودافون كاش
    if (payment_method === 'vodafone') {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'يرجى رفع صورة إيصال فودافون كاش' });
      }

      const receiptCheck = await checkReceiptWithAI({
        imageBuffer: req.file.buffer,
        mimeType: req.file.mimetype,
        PaymentVerification,
        BookletReservation,
      });

      if (!receiptCheck.success) {
        return res.status(400).json({ success: false, message: receiptCheck.message });
      }

      transactionReference = receiptCheck.transactionReference;

      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'booklet_reservations', resource_type: 'image' },
          (error, result) => error ? reject(error) : resolve(result)
        );
        const readable = new Readable();
        readable.push(req.file.buffer);
        readable.push(null);
        readable.pipe(stream);
      });
      transferImageUrl = uploadResult.secure_url;
    }

    await BookletReservation.create({
      StudentId: student.id,
      BookletId: booklet.id,
      payment_method,
      transfer_image_url: transferImageUrl,
      transaction_reference: transactionReference,
      status: 'pending',
    });

    res.json({ success: true, message: payment_method === 'vodafone' ? '✅ تم إرسال الحجز، في انتظار التحقق من التحويل' : '✅ تم الحجز، ادفع عند التسجيل في السنتر' });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

// ===== تقرير الحصة المالي المفصل =====

app.get('/sessions/:id/financial-report', requireAdmin, async (req, res) => {
  try {
    const { filter_user, filter_type } = req.query;
    const session = await Session.findByPk(req.params.id, { include: [Center, Subject] });
    if (!session) return res.status(404).send('❌');

    const whereAtt = { SessionId: session.id };
    if (filter_user) whereAtt.UserId = filter_user;

    const attendances = await Attendance.findAll({
      where: whereAtt,
      include: [Student, User],
    });

    // تجميع المدفوعات
    const rows = attendances.map(a => ({
      studentName: a.Student?.name || '-',
      studentCode: a.Student?.student_code || '-',
      assistantName: a.User?.name || '-',
      assistantId: a.UserId,
      sessionPayment: a.payment_collected || 0,
      attendedAt: a.attended_at,
    }));

    // مدفوعات البوكليتس في نفس اليوم (بناءً على التاريخ)
    const sessionDate = session.session_date;
    const bookletTransactions = await BalanceTransaction.findAll({
      where: {
        reason: { [Op.like]: 'دفع بوكليت:%' },
        createdAt: { [Op.between]: [sessionDate + ' 00:00:00', sessionDate + ' 23:59:59'] },
      },
      include: [Student, User],
    });

    const allUsers = await User.findAll({ order: [['name', 'ASC']] });

    const totalSession = rows.reduce((s, r) => s + r.sessionPayment, 0);
    const totalBooklets = bookletTransactions.reduce((s, t) => s + t.amount, 0);
    const assistantMap = new Map();

    const ensureAssistantBucket = (user) => {
      const key = user?.id || 'unknown';
      if (!assistantMap.has(key)) {
        assistantMap.set(key, {
          assistantId: user?.id || null,
          assistantName: user?.name || '-',
          sessionTotal: 0,
          bookletTotal: 0,
        });
      }
      return assistantMap.get(key);
    };

    attendances.forEach(a => {
      const bucket = ensureAssistantBucket(a.User);
      bucket.sessionTotal += a.payment_collected || 0;
    });

    bookletTransactions.forEach(t => {
      const bucket = ensureAssistantBucket(t.User);
      bucket.bookletTotal += t.amount || 0;
    });

    const assistantBreakdown = Array.from(assistantMap.values())
      .sort((a, b) => a.assistantName.localeCompare(b.assistantName, 'ar'));

    res.render('session-financial-report', {
      session, rows, bookletTransactions, allUsers,
      totalSession, totalBooklets, totalAll: totalSession + totalBooklets,
      assistantBreakdown,
      filters: { filter_user, filter_type: filter_type || 'all' },
    });
  } catch (e) { console.error(e); res.status(500).send('❌ ' + e.message); }
});


async function startServer() {
  try {
    await sequelize.authenticate();
    console.log('✅ تم الاتصال بقاعدة البيانات بنجاح');
    // IMPORTANT: منع sync المؤقتًا لتجنب Duplicate keys أثناء تشغيل السيرفر
    // await sequelize.sync();
    await RechargeCode.sync();
    await PaymentVerification.sync();
    await ensureBookletReservationSchema(sequelize);
    console.log('RechargeCode table is ready');
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
