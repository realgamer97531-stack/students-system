require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const sequelize = require('./config/database');
const { Op, QueryTypes } = require('sequelize');
const https = require('https');
const fs = require('fs');
const qrcodeTerminal = require('qrcode-terminal');
const getLocalIP = require('./utils/getLocalIP');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const PERMISSIONS_LIST = require('./permissions');
const cron = require('node-cron');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const compression = require('compression');
const RechargeCode = require('./models/RechargeCode');
const crypto = require('crypto');
const execFileAsync = promisify(execFile);

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
const PaymentVerification = require('./models/PaymentVerification');
const ensureBookletReservationSchema = require('./utils/ensureBookletReservationSchema');
const checkReceiptWithAI = require('./utils/checkReceiptWithAI');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');
const FollowUpAssignment = require('./models/FollowUpAssignment');
const SessionComment = require('./models/SessionComment');
const XLSX = require('xlsx');
const bulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const databaseBackupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const profilePhotoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const VideoSession = require('./models/VideoSession');
const VideoStudentAccess = require('./models/VideoStudentAccess');

VideoSession.belongsTo(Video, { foreignKey: 'VideoId' });
VideoSession.belongsTo(Session, { foreignKey: 'SessionId' });
Video.hasMany(VideoSession, { foreignKey: 'VideoId' });

VideoStudentAccess.belongsTo(Video, { foreignKey: 'VideoId' });
VideoStudentAccess.belongsTo(Student, { foreignKey: 'StudentId' });
Video.hasMany(VideoStudentAccess, { foreignKey: 'VideoId' });

function normalizePhoneForWhatsApp(phone) {
  if (!phone) return null;

  const cleaned = String(phone).trim().replace(/\s+/g, '');
  if (!cleaned) return null;

  let digits = cleaned.replace(/[^\d]/g, '');
  if (!digits) return null;

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('+')) digits = digits.slice(1);

  if (digits.startsWith('20') && digits.length > 10) {
    return digits;
  }

  if (digits.startsWith('201')) {
    return digits;
  }

  if (digits.startsWith('0')) {
    return '20' + digits.slice(1);
  }

  if (digits.startsWith('2') && digits.length === 11) {
    return digits;
  }

  if (digits.length === 10) {
    return '20' + digits;
  }

  return digits;
}

async function getFollowUpAssistantForStudent(studentId) {
  try {
    const assignment = await FollowUpAssignment.findOne({
      where: { StudentId: studentId },
      include: [{ model: User, as: 'Assistant', attributes: ['id', 'name', 'username', 'phone'] }],
    });

    if (!assignment?.Assistant) return null;

    const assistantPhone = assignment.Assistant.phone || assignment.Assistant.username || null;
    const whatsappPhone = normalizePhoneForWhatsApp(assistantPhone);

    return {
      name: assignment.Assistant.name || null,
      phone: assistantPhone || null,
      whatsappPhone,
    };
  } catch (error) {
    console.error('Failed to load follow-up assistant:', error.message);
    return null;
  }
}

SessionComment.belongsTo(Student, { foreignKey: 'StudentId' });
SessionComment.belongsTo(Session, { foreignKey: 'SessionId' });
SessionComment.belongsTo(User, { foreignKey: 'UserId' });

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
let dbReady = false;

async function ensureUserPhoneColumn() {
  try {
    const queryInterface = sequelize.getQueryInterface();
    const tableInfo = await queryInterface.describeTable('users');
    if (!tableInfo.phone) {
      await queryInterface.addColumn('users', 'phone', {
        type: sequelize.Sequelize.STRING,
        allowNull: true,
      });
      console.log('✅ Added phone column to users table');
    }
  } catch (error) {
    if (error.message && error.message.includes('does not exist')) {
      return;
    }
    console.error('Failed to ensure users.phone column:', error.message);
  }
}

async function ensureSessionWeekNumberColumn() {
  try {
    const queryInterface = sequelize.getQueryInterface();
    const tableInfo = await queryInterface.describeTable('sessions');
    if (!tableInfo.week_number) {
      await queryInterface.addColumn('sessions', 'week_number', {
        type: sequelize.Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null,
      });
      console.log('✅ Added week_number column to sessions table');
    }
  } catch (error) {
    if (error.message && error.message.includes('does not exist')) {
      return;
    }
    console.error('Failed to ensure sessions.week_number column:', error.message);
  }
}

async function ensureStudentBookletCustomPriceColumn() {
  try {
    const queryInterface = sequelize.getQueryInterface();
    const tableInfo = await queryInterface.describeTable('StudentBooklets');
    if (!tableInfo.custom_price) {
      await queryInterface.addColumn('StudentBooklets', 'custom_price', {
        type: sequelize.Sequelize.FLOAT,
        allowNull: true,
      });
      console.log('✅ Added custom_price column to StudentBooklets table');
    }
  } catch (error) {
    if (error.message && error.message.includes('does not exist')) {
      return;
    }
    console.error('Failed to ensure StudentBooklets.custom_price column:', error.message);
  }
}

async function ensureBalanceTransactionSessionColumn() {
  try {
    const queryInterface = sequelize.getQueryInterface();
    const tableInfo = await queryInterface.describeTable('balancetransactions');
    if (!tableInfo.SessionId) {
      await queryInterface.addColumn('balancetransactions', 'SessionId', {
        type: sequelize.Sequelize.INTEGER,
        allowNull: true,
      });
      console.log('✅ Added SessionId column to balancetransactions table');
    }
  } catch (error) {
    if (error.message && error.message.includes('does not exist')) {
      return;
    }
    console.error('Failed to ensure balancetransactions.SessionId column:', error.message);
  }
}

async function ensureHomeworkAssignmentShowForAllColumn() {
  try {
    const queryInterface = sequelize.getQueryInterface();
    const tableInfo = await queryInterface.describeTable('HomeworkAssignments');
    if (!tableInfo.show_for_all) {
      await queryInterface.addColumn('HomeworkAssignments', 'show_for_all', {
        type: sequelize.Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
      console.log('✅ Added show_for_all column to HomeworkAssignments table');
    }
  } catch (error) {
    if (error.message && error.message.includes('does not exist')) {
      return;
    }
    console.error('Failed to ensure HomeworkAssignments.show_for_all column:', error.message);
  }
}

async function ensureUserProfilePhotoColumn() {
  try {
    const queryInterface = sequelize.getQueryInterface();
    const tableInfo = await queryInterface.describeTable('users');
    if (!tableInfo.profile_photo_url) {
      await queryInterface.addColumn('users', 'profile_photo_url', {
        type: sequelize.Sequelize.STRING,
        allowNull: true,
      });
      console.log('✅ Added profile_photo_url column to users table');
    }
  } catch (error) {
    if (error.message && error.message.includes('does not exist')) {
      return;
    }
    console.error('Failed to ensure users.profile_photo_url column:', error.message);
  }
}

async function connectWithRetry(maxAttempts = 5, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sequelize.authenticate();
      console.log(`✅ تم الاتصال بقاعدة البيانات بنجاح (attempt ${attempt})`);
      return;
    } catch (error) {
      console.error(`⚠️ محاولة الاتصال بقاعدة البيانات فشلت (${attempt}/${maxAttempts}):`, error.message);
      if (attempt === maxAttempts) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

function getEffectiveBookletPrice(booklet, studentBooklet) {
  if (studentBooklet && studentBooklet.custom_price !== null && studentBooklet.custom_price !== undefined) {
    const customPrice = parseFloat(studentBooklet.custom_price);
    if (!Number.isNaN(customPrice) && customPrice >= 0) {
      return customPrice;
    }
  }

  if (booklet && booklet.sell_price !== null && booklet.sell_price !== undefined) {
    const basePrice = parseFloat(booklet.sell_price);
    if (!Number.isNaN(basePrice) && basePrice >= 0) {
      return basePrice;
    }
  }

  return 0;
}

function getBookletRemainingAmount(booklet, studentBooklet) {
  const effectivePrice = getEffectiveBookletPrice(booklet, studentBooklet);
  const paidAmount = studentBooklet ? parseFloat(studentBooklet.paid_amount || 0) : 0;
  return Math.max(0, effectivePrice - paidAmount);
}

async function syncStudentBookletStatus(student) {
  if (!student) return;
  const hasStudentBooklet = await StudentBooklet.count({ where: { StudentId: student.id } }) > 0;
  if (hasStudentBooklet && !student.booklet_status) {
    student.booklet_status = true;
    await student.save();
  }
}

async function ensureStudentBookletPlaceholder(student, booklets = null) {
  if (!student || !student.booklet_status) return;
  const activeBooklets = booklets || await Booklet.findAll({
    where: { SubjectId: student.SubjectId, is_active: true },
    order: [['order_index', 'ASC']],
  });
  if (!activeBooklets || activeBooklets.length === 0) return;

  const defaultBooklet = activeBooklets[0];
  const existing = await StudentBooklet.findOne({
    where: { StudentId: student.id, BookletId: defaultBooklet.id },
  });
  if (!existing) {
    await StudentBooklet.create({
      StudentId: student.id,
      BookletId: defaultBooklet.id,
      paid_amount: 0,
      custom_price: defaultBooklet.sell_price,
    });
  }
}

async function markDefaultBookletDelivered(student) {
  if (!student) return null;
  const booklets = await Booklet.findAll({ where: { SubjectId: student.SubjectId, is_active: true }, order: [['order_index', 'ASC']] });
  if (!booklets.length) return null;

  const defaultBooklet = booklets[0];
  const [sb] = await StudentBooklet.findOrCreate({
    where: { StudentId: student.id, BookletId: defaultBooklet.id },
    defaults: {
      paid_amount: 0,
      custom_price: defaultBooklet.sell_price,
    },
  });

  if (sb.custom_price === null || sb.custom_price === undefined) {
    sb.custom_price = defaultBooklet.sell_price;
  }

  sb.is_delivered = true;
  sb.delivered_at = new Date();
  await sb.save();

  if (!student.booklet_status) {
    student.booklet_status = true;
    await student.save();
  }

  return sb;
}

async function recordAttendanceCharge(student, userId, reason = 'رسوم الحضور', transaction = null) {
  if (!student) return 0;

  const amount = parseFloat(student.price_per_session || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const signedAmount = -amount;
  student.balance += signedAmount;
  await student.save({ transaction });

  await BalanceTransaction.create({
    StudentId: student.id,
    amount: signedAmount,
    reason,
    UserId: userId,
  }, { transaction });

  return amount;
}

function getEffectiveSessionPayment(attendance) {
  const manualAmount = parseFloat(attendance?.payment_collected || 0);
  const sessionFee = parseFloat(attendance?.Student?.price_per_session || 0);
  return Math.max(manualAmount, sessionFee);
}

function getActualSessionPayment(attendance) {
  return parseFloat(attendance?.payment_collected || 0);
}

app.use(cors()); // يسمح لأي موقع يتواصل مع الـ API بتاعنا
app.use(compression());
app.use(cors({
  origin: [
    'https://studyisfunny.online', 
    'https://shadyelsharkawy.com',
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

// تجهيز رفع صور الحصص وحفظها في فولدر public/uploads/session-images
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'uploads', 'session-images');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  },
});
const imageUpload = multer({ storage: imageStorage, limits: { fileSize: 10 * 1024 * 1024 } });

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
app.use(async (req, res, next) => {
  res.locals.userName = req.session.userName || null;
  res.locals.userRole = req.session.userRole || null;
  res.locals.userProfilePhoto = null;

  // Fetch user profile photo if logged in
  if (req.session.userId) {
    try {
      const user = await User.findByPk(req.session.userId);
      if (user && user.profile_photo_url) {
        res.locals.userProfilePhoto = user.profile_photo_url;
      }
    } catch (e) {
      console.error('Error fetching user profile photo:', e);
    }
  }

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
    if (req.session.userRole === 'follow_up' && key === 'follow_up') return next();
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
  res.locals.userPermissions = Array.isArray(req.session.userPermissions) ? req.session.userPermissions : [];
  res.locals.PERMISSIONS_LIST = PERMISSIONS_LIST;
  next();
});

function escapeSqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "\\'")}'`;
  const normalized = String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${normalized}'`;
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let escapeNext = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];

    if (quote) {
      current += ch;
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);

  return statements;
}

async function exportDatabaseSql() {
  const databaseName = process.env.DB_NAME;
  const tables = await sequelize.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    { replacements: [databaseName], type: QueryTypes.SELECT }
  );

  const statements = [];

  for (const tableRow of tables) {
    const tableName = tableRow.TABLE_NAME;
    const createResult = await sequelize.query(`SHOW CREATE TABLE \`${tableName}\``, { type: QueryTypes.SELECT });
    const createSql = createResult[0] && (createResult[0]['Create Table'] || createResult[0]['Create table']);
    if (createSql) {
      statements.push(`${createSql};`);
    }

    const rows = await sequelize.query(`SELECT * FROM \`${tableName}\``, { type: QueryTypes.SELECT });
    if (!rows.length) continue;

    const columns = Object.keys(rows[0]);
    if (!columns.length) continue;

    for (const row of rows) {
      const values = columns.map((column) => escapeSqlValue(row[column]));
      statements.push(`INSERT INTO \`${tableName}\` (\`${columns.join('`, `')}\`) VALUES (${values.join(', ')});`);
    }
  }

  return statements.join('\n');
}

async function importDatabaseSql(sqlText) {
  const statements = splitSqlStatements(sqlText);
  if (!statements.length) {
    throw new Error('ملف النسخة الاحتياطية فارغ');
  }

  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const statement of statements) {
      await sequelize.query(statement);
    }
  } finally {
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

// ===== Settings Route =====
app.get('/settings', requireAdmin, async (req, res) => {
  const sessions = await Session.findAll({
    attributes: ['id', 'serial_number', 'lesson_number', 'session_date', 'status'],
    order: [['serial_number', 'DESC']],
  });
  res.render('settings', { sessions });
});

app.post('/settings/session-tools', requireAdmin, async (req, res) => {
  const serial = String(req.body.session_serial || '').trim();
  const action = req.body.action;
  const sessions = await Session.findAll({
    attributes: ['id', 'serial_number', 'lesson_number', 'session_date', 'status'],
    order: [['serial_number', 'DESC']],
  });

  if (!/^\d+$/.test(serial) || !['preview-delete', 'delete', 'mark-complete'].includes(action)) {
    return res.status(400).render('settings', { sessions, errorMessage: 'اختر حصة وعملية صحيحة.' });
  }

  const target = sessions.find(session => String(session.serial_number) === serial);
  if (!target) {
    return res.status(404).render('settings', { sessions, errorMessage: 'الحصة المختارة غير موجودة.' });
  }

  const script = action === 'mark-complete'
    ? 'mark_session_homework_complete.js'
    : 'delete_session_6001.js';
  const args = [path.join(__dirname, 'scripts', script), serial];
  if (action === 'delete') args.push('--apply', '--confirm');
  if (action === 'mark-complete') args.push('--apply', '--confirm');

  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: __dirname,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: true,
    });
    return res.render('settings', {
      sessions,
      successMessage: action === 'preview-delete' ? 'تم إنشاء المعاينة بدون أي تعديل.' : 'تم تنفيذ العملية بنجاح.',
      sessionToolsOutput: result.stdout || result.stderr,
    });
  } catch (error) {
    return res.status(500).render('settings', {
      sessions,
      errorMessage: 'فشلت العملية ولم يتم ضمان إكمالها. راجع التفاصيل أدناه.',
      sessionToolsOutput: [error.stdout, error.stderr, error.message].filter(Boolean).join('\n'),
    });
  }
});

app.get('/settings/export-database', requireAdmin, async (req, res) => {
  try {
    const filename = `database_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
    const sql = await exportDatabaseSql();
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(sql);
  } catch (error) {
    console.error('❌ فشل تصدير قاعدة البيانات:', error.message);
    res.status(500).render('settings', { errorMessage: 'فشل تصدير قاعدة البيانات' });
  }
});

app.post('/settings/import-database', requireAdmin, databaseBackupUpload.single('database_file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).render('settings', { errorMessage: 'يرجى اختيار ملف النسخة الاحتياطية' });
    }

    const sqlText = req.file.buffer.toString('utf8');
    await importDatabaseSql(sqlText);
    res.render('settings', { successMessage: 'تم استيراد قاعدة البيانات بنجاح' });
  } catch (error) {
    console.error('❌ فشل استيراد قاعدة البيانات:', error.message);
    res.status(500).render('settings', { errorMessage: 'حدث خطأ أثناء استيراد قاعدة البيانات' });
  }
});

async function verifyAdminPassword(userId, password) {
  const adminUser = await User.findByPk(userId);
  if (!adminUser) return false;
  return bcrypt.compare(password, adminUser.password);
}

app.post('/settings/clear-db', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    const verified = await verifyAdminPassword(req.session.userId, password);
    if (!verified) {
      return res.status(403).render('settings', { errorMessage: 'كلمة المرور غير صحيحة' });
    }

    await Promise.all([
      Attendance.destroy({ where: {} }),
      HomeworkCheck.destroy({ where: {} }),
      BalanceTransaction.destroy({ where: {} }),
      ExamResult.destroy({ where: {} }),
      WatchProgress.destroy({ where: {} }),
      VideoAccessGrant.destroy({ where: {} }),
      Warning.destroy({ where: {} }),
      StudentBooklet.destroy({ where: {} }),
      BookletReservation.destroy({ where: {} }),
      VideoSession.destroy({ where: {} }),
      VideoStudentAccess.destroy({ where: {} }),
      Session.destroy({ where: {} }),
      Student.destroy({ where: {} }),
      VideoPart.destroy({ where: {} }),
      Video.destroy({ where: {} }),
    ]);

    res.render('settings', { successMessage: 'تم مسح قاعدة البيانات بالكامل بنجاح' });
  } catch (e) {
    console.error(e);
    res.status(500).render('settings', { errorMessage: 'حدث خطأ أثناء المسح' });
  }
});

app.post('/settings/clear-students', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    const verified = await verifyAdminPassword(req.session.userId, password);
    if (!verified) {
      return res.status(403).render('settings', { errorMessage: 'كلمة المرور غير صحيحة' });
    }

    await Promise.all([
      Attendance.destroy({ where: {} }),
      HomeworkCheck.destroy({ where: {} }),
      ExamResult.destroy({ where: {} }),
      BalanceTransaction.destroy({ where: {} }),
      WatchProgress.destroy({ where: {} }),
      VideoAccessGrant.destroy({ where: {} }),
      FollowUpAssignment.destroy({ where: {} }),
      SessionComment.destroy({ where: {} }),
      StudentBooklet.destroy({ where: {} }),
      BookletReservation.destroy({ where: {} }),
      Warning.destroy({ where: {} }),
      Student.destroy({ where: {} }),
    ]);

    res.render('settings', { successMessage: 'تم مسح جميع الطلاب وبياناتهم بنجاح' });
  } catch (e) {
    console.error(e);
    res.status(500).render('settings', { errorMessage: 'حدث خطأ أثناء مسح الطلاب' });
  }
});

app.post('/settings/clear-sessions', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    const verified = await verifyAdminPassword(req.session.userId, password);
    if (!verified) {
      return res.status(403).render('settings', { errorMessage: 'كلمة المرور غير صحيحة' });
    }

    await Promise.all([
      Attendance.destroy({ where: {} }),
      HomeworkCheck.destroy({ where: {} }),
      SessionComment.destroy({ where: {} }),
      Session.destroy({ where: {} }),
    ]);

    res.render('settings', { successMessage: 'تم مسح جميع الجلسات بنجاح' });
  } catch (e) {
    console.error(e);
    res.status(500).render('settings', { errorMessage: 'حدث خطأ أثناء مسح الجلسات' });
  }
});

app.post('/settings/clear-videos', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    const verified = await verifyAdminPassword(req.session.userId, password);
    if (!verified) {
      return res.status(403).render('settings', { errorMessage: 'كلمة المرور غير صحيحة' });
    }

    await Promise.all([
      VideoSession.destroy({ where: {} }),
      VideoStudentAccess.destroy({ where: {} }),
      VideoPart.destroy({ where: {} }),
      Video.destroy({ where: {} }),
    ]);

    res.render('settings', { successMessage: 'تم مسح جميع الفيديوهات بنجاح' });
  } catch (e) {
    console.error(e);
    res.status(500).render('settings', { errorMessage: 'حدث خطأ أثناء مسح الفيديوهات' });
  }
});

// ===== Routes بتاعة الطلاب =====

app.get('/students', requirePermission('students_view'), async (req, res) => {
  const { search, center_id, subject_id, booklet_remaining_only, low_balance_only } = req.query;
  const showBookletRemainingOnly = booklet_remaining_only === '1' || booklet_remaining_only === 'on';
  const showLowBalanceOnly = low_balance_only === '1' || low_balance_only === 'on';

  const where = {};
  if (center_id) where.CenterId = center_id;
  if (subject_id) where.SubjectId = subject_id;

  let students = await Student.findAll({
    where,
    include: [Center, Subject],
    order: [['createdAt', 'DESC']],
  });

  const normalizedSearch = String(search || '').trim().toLowerCase();
  const normalizedDigits = normalizedSearch.replace(/\D/g, '');

  if (normalizedSearch) {
    students = students.filter((student) => {
      const searchableValues = [student.name, student.student_code, student.phone, student.parent_phone];
      return searchableValues.some((value) => {
        if (!value) return false;
        const text = String(value).toLowerCase();
        return text.includes(normalizedSearch) || (normalizedDigits && String(value).replace(/\D/g, '').includes(normalizedDigits));
      });
    });
  }

  if (showBookletRemainingOnly) {
    const studentBooklets = await StudentBooklet.findAll({
      where: { StudentId: students.map((student) => student.id) },
      include: [Booklet],
    });

    const studentsWithBookletRemaining = new Set(
      studentBooklets
        .filter((studentBooklet) => getBookletRemainingAmount(studentBooklet.Booklet, studentBooklet) > 0)
        .map((studentBooklet) => studentBooklet.StudentId)
    );

    students = students.filter((student) => studentsWithBookletRemaining.has(student.id));
  }

  if (showLowBalanceOnly) {
    students = students.filter((student) => Number(student.balance || 0) <= 90);
  }

  const centers = await Center.findAll();
  const subjects = await Subject.findAll();

  // Compute total paid amounts for booklets per student so the list view can show "Paid Price for the Current Booklet"
  const studentBooklets = await StudentBooklet.findAll({
    where: { StudentId: students.map(student => student.id) },
  });

  const bookletPaidTotals = {};
  studentBooklets.forEach(studentBooklet => {
    bookletPaidTotals[studentBooklet.StudentId] = (bookletPaidTotals[studentBooklet.StudentId] || 0) + Number(studentBooklet.paid_amount || 0);
  });

  res.render('students-list', {
    students,
    centers,
    subjects,
    bookletPaidTotals,
    filters: {
      search: search || '',
      center_id: center_id || '',
      subject_id: subject_id || '',
      booklet_remaining_only: showBookletRemainingOnly ? '1' : '',
      low_balance_only: showLowBalanceOnly ? '1' : '',
    },
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
    const { search, center_id, subject_id, booklet_remaining_only, low_balance_only } = req.query;
    const showBookletRemainingOnly = booklet_remaining_only === '1' || booklet_remaining_only === 'on';
    const showLowBalanceOnly = low_balance_only === '1' || low_balance_only === 'on';

    const where = {};
    if (center_id) where.CenterId = center_id;
    if (subject_id) where.SubjectId = subject_id;

    let students = await Student.findAll({
      where,
      include: [Center, Subject],
      order: [['name', 'ASC']],
    });

    const normalizedSearch = String(search || '').trim().toLowerCase();
    const normalizedDigits = normalizedSearch.replace(/\D/g, '');

    if (normalizedSearch) {
      students = students.filter((student) => {
        const searchableValues = [student.name, student.student_code, student.phone, student.parent_phone];
        return searchableValues.some((value) => {
          if (!value) return false;
          const text = String(value).toLowerCase();
          return text.includes(normalizedSearch) || (normalizedDigits && String(value).replace(/\D/g, '').includes(normalizedDigits));
        });
      });
    }

    if (showBookletRemainingOnly) {
      const studentBooklets = await StudentBooklet.findAll({
        where: { StudentId: students.map((student) => student.id) },
        include: [Booklet],
      });

      const studentsWithBookletRemaining = new Set(
        studentBooklets
          .filter((studentBooklet) => getBookletRemainingAmount(studentBooklet.Booklet, studentBooklet) > 0)
          .map((studentBooklet) => studentBooklet.StudentId)
      );

      students = students.filter((student) => studentsWithBookletRemaining.has(student.id));
    }

    if (showLowBalanceOnly) {
      students = students.filter((student) => Number(student.balance || 0) <= 90);
    }

    const studentBooklets = await StudentBooklet.findAll({
      where: { StudentId: students.map(student => student.id) },
    });

    const bookletPaidTotals = {};
    studentBooklets.forEach(studentBooklet => {
      bookletPaidTotals[studentBooklet.StudentId] = (bookletPaidTotals[studentBooklet.StudentId] || 0) + Number(studentBooklet.paid_amount || 0);
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('الطلاب');

    sheet.columns = [
      { header: 'id', key: 'id', width: 12 },
      { header: 'name', key: 'name', width: 25 },
      { header: 'phone', key: 'phone', width: 18 },
      { header: 'parent phone', key: 'parent_phone', width: 18 },
      { header: 'comment', key: 'has_comment', width: 35 },
      { header: 'center', key: 'center', width: 20 },
      { header: 'subject', key: 'subject', width: 20 },
      { header: 'balance', key: 'balance', width: 12 },
      { header: 'booklet paid balance', key: 'booklet_paid_balance', width: 20 },
      { header: 'price of his session', key: 'price', width: 18 },
    ];

    students.forEach(s => {
      sheet.addRow({
        id: s.id,
        name: s.name,
        phone: s.phone,
        parent_phone: s.parent_phone,
        has_comment: s.admin_note || '-',
        center: s.Center ? s.Center.name : '-',
        subject: s.Subject ? s.Subject.name : '-',
        balance: s.balance,
        booklet_paid_balance: bookletPaidTotals[s.id] || 0,
        price: s.price_per_session,
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

  // تحميل التيمبليت
  app.get('/students/bulk-template', requireAdmin, async (req, res) => {
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('طلاب جدد');

      sheet.columns = [
        { header: 'name', key: 'name', width: 25 },
        { header: 'phone', key: 'phone', width: 15 },
        { header: 'parent_phone', key: 'parent_phone', width: 15 },
        { header: 'subject_name', key: 'subject_name', width: 25 },
        { header: 'center_name', key: 'center_name', width: 20 },
        { header: 'price_per_session', key: 'price_per_session', width: 15 },
        { header: 'initial_balance', key: 'initial_balance', width: 15 },
        { header: 'booklet_name', key: 'booklet_name', width: 25 },
        { header: 'booklet_paid', key: 'booklet_paid', width: 12 },
      ];

      sheet.addRow(['محمد أحمد', '01012345678', '01198765432', 'Math Senior 1', 'جلوري', '80', '0', 'بوكليت أول ثانوي', '0']);
      sheet.addRow(['فاطمة علي', '01023456789', '01187654321', 'Math Senior 1', 'الرياض ميامي', '80', '160', '', '']);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=students_template.xlsx');
      await workbook.xlsx.write(res);
      res.end();
    } catch (e) {
      console.error('Failed to generate bulk template:', e);
      res.status(500).send('❌ ' + e.message);
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

    const ownSessionIds = new Set(ownSessions.map(s => s.id));
    const attendanceByLesson = {};
    const attendanceUserByLesson = {};
    const attendanceTimeByLesson = {};
    const attendanceIdByLesson = {};
    attendanceRecords.forEach(a => {
      if (a && a.Session && a.Session.SubjectId === student.SubjectId) {
        const key = Number(a.Session.lesson_number);
        const current = attendanceByLesson[key];
        const isPreferred = ownSessionIds.has(a.SessionId);
        const currentPreferred = current && current.id && ownSessionIds.has(current.id);

        if (!current || (isPreferred && !currentPreferred) || (!current.id && a.SessionId)) {
          attendanceByLesson[key] = a.Session;
          attendanceUserByLesson[key] = a.User ? a.User.name : '-';
          attendanceTimeByLesson[key] = a.attended_at;
          attendanceIdByLesson[key] = a.id;
        }
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
      if (h && h.Session && h.Session.SubjectId === student.SubjectId) {
        const key = Number(h.Session.lesson_number);
        const current = homeworkByLesson[key];
        const isPreferred = ownSessionIds.has(h.SessionId);
        const currentPreferred = current && current.sessionId && ownSessionIds.has(current.sessionId);

        if (!current || (isPreferred && !currentPreferred) || (!current.sessionId && h.SessionId)) {
          homeworkByLesson[key] = h.status;
          homeworkUserByLesson[key] = h.User ? h.User.name : '-';
          homeworkTimeByLesson[key] = h.createdAt;
        }
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
      if (r && r.Exam && r.Exam.Session) {
        const key = Number(r.Exam.Session.lesson_number);
        const current = examScoreByLesson[key];
        const isPreferred = ownSessionIds.has(r.Exam.SessionId);
        const currentPreferred = current && current.sessionId && ownSessionIds.has(current.sessionId);

        if (!current || (isPreferred && !currentPreferred) || (!current.sessionId && r.Exam.SessionId)) {
          examScoreByLesson[key] = {
            score: r.score,
            max_score: r.Exam.max_score,
            examName: r.Exam.name,
            recordedBy: r.User ? r.User.name : '-',
            recordedAt: r.createdAt,
            sessionId: r.Exam.SessionId,
          };
        }
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

    // بيانات مشاهدة الفيديوهات المتاحة لهذا الطالب فقط
    const studentSessions = await Session.findAll({
      where: { SubjectId: student.SubjectId, CenterId: student.CenterId },
    });
    const studentSessionIds = studentSessions.map(s => s.id);

    const groupVideoSessions = studentSessionIds.length > 0 ? await VideoSession.findAll({
      where: { SessionId: studentSessionIds },
      attributes: ['VideoId'],
    }) : [];
    const groupVideoIds = [...new Set(groupVideoSessions.map(vs => vs.VideoId))];

    const individualAccesses = await VideoStudentAccess.findAll({
      where: { StudentId: student.id },
      attributes: ['VideoId'],
    });
    const individualVideoIds = individualAccesses.map(a => a.VideoId);

    const accessibleVideoIds = [...new Set([...groupVideoIds, ...individualVideoIds])];
    const studentVideos = accessibleVideoIds.length > 0 ? await Video.findAll({
      where: { id: accessibleVideoIds },
      include: [{ model: Session, include: [Center] }, VideoPart],
      order: [['createdAt', 'ASC']],
    }) : [];

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
    await syncStudentBookletStatus(student);
    if (!student.booklet_status && studentBooklets.length > 0) {
      student.booklet_status = true;
      await student.save();
    }

    const availableBooklets = await Booklet.findAll({
      where: { SubjectId: student.SubjectId, is_active: true },
    });

    const followUpAssistant = await getFollowUpAssistantForStudent(student.id);
    const profilePhotoUrl = student.profile_photo_url || null;

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
      followUpAssistant,
      profilePhotoUrl,
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
    const {
      name,
      phone,
      parent_phone,
      price_per_session,
      balance,
      booklet_status,
      booklet_paid_amount,
      register_attendance,
      comment,
      center_id,
      subject_id,
      admin_password,
    } = req.body;

    // Validate phone lengths (must be 11 digits). Admin password can override.
    const cleanDigits = v => (v || '').toString().replace(/[^0-9]/g, '');
    const phoneDigits = cleanDigits(phone);
    const parentDigits = cleanDigits(parent_phone);
    if (phoneDigits.length !== 11 || parentDigits.length !== 11) {
      if (!admin_password) {
        const centers = await Center.findAll();
        const subjects = await Subject.findAll();
        return res.status(400).render('add-student', { centers, subjects, errorMessage: 'أرقام التليفون غير صحيحة: يجب أن تكون مكونة من 11 رقمًا. يمكنك إدخال كلمة المرور الإدارية للموافقة.' });
      }
      const verified = await verifyAdminPassword(req.session.userId, admin_password);
      if (!verified) {
        const centers = await Center.findAll();
        const subjects = await Subject.findAll();
        return res.status(403).render('add-student', { centers, subjects, errorMessage: 'كلمة المرور الإدارية غير صحيحة.' });
      }
    }

    const existingStudent = await Student.findOne({
      where: {
        name: name,
        phone: phone,
        parent_phone: parent_phone,
        CenterId: center_id,
        SubjectId: subject_id,
      },
    });

    if (existingStudent) {
      if (admin_password !== process.env.ADMIN_DUPLICATE_PASSWORD) {
        return res.status(409).json({
          success: false,
          isDuplicate: true,
          message: `⚠️ تحذير: وجدنا طالب بنفس البيانات!\n\nالاسم: ${existingStudent.name}\nالتليفون: ${existingStudent.phone}\nولي الأمر: ${existingStudent.parent_phone}\n\nهل تريد المتابعة بإدخال كلمة المرور الإدارية؟`,
          studentCode: existingStudent.student_code,
        });
      }
    }

    const initialBalance = parseFloat(balance) || 0;
    const paidAmount = parseFloat(booklet_paid_amount) || 0;
    const shouldHaveBookletStatus = booklet_status === 'on' || paidAmount > 0;

    const student = await Student.create({
      name,
      phone,
      parent_phone,
      price_per_session,
      balance: initialBalance,
      booklet_status: shouldHaveBookletStatus,
      CenterId: center_id,
      SubjectId: subject_id,
      UserId: req.session.userId,
    });

    let attendanceNote = null;

    if (paidAmount > 0) {
      const booklet = await Booklet.findOne({
        where: { SubjectId: subject_id, is_active: true },
        order: [['order_index', 'ASC']],
      });
      if (booklet) {
        await processBookletPayments(student.id, [{ booklet_id: booklet.id, amount: paidAmount }], req.session.userId, register_attendance === 'on' ? req.session.activeSessionId : null);
      }
    } else if (shouldHaveBookletStatus) {
      await ensureStudentBookletPlaceholder(student);
    }

    if (register_attendance === 'on') {
      const sessionId = req.session.activeSessionId;
      if (!sessionId) {
        attendanceNote = '⚠️ لا توجد حصة شغالة الآن لتسجيل حضور الطالب.';
      } else {
        const activeSession = await Session.findByPk(sessionId);
        if (!activeSession || activeSession.status === 'cancelled') {
          attendanceNote = '⚠️ الحصة الحالية غير متاحة للتسجيل.';
        } else {
          const existingAttendance = await Attendance.findOne({
            where: { StudentId: student.id, SessionId: sessionId },
          });
          if (existingAttendance) {
            attendanceNote = '⚠️ الطالب مسجل حضور في هذه الحصة بالفعل.';
          } else if (student.balance < student.price_per_session) {
            attendanceNote = `⚠️ رصيد الطالب غير كافٍ لتسجيل الحضور (الرصيد: ${student.balance} ج).`;
          } else {
            await recordAttendanceCharge(student, req.session.userId, 'رسوم الحضور');

            await Attendance.create({
              StudentId: student.id,
              SessionId: sessionId,
              UserId: req.session.userId,
              comment: comment || null,
              payment_collected: initialBalance,
            });
            await addPoints(student.id, 2);
            attendanceNote = '✅ تم تسجيل حضور الطالب في الحصة الحالية.';
          }
        }
      }
    }

    const qrCodeImage = await QRCode.toDataURL(student.student_code);
    res.render('student-created', { student, qrCodeImage, attendanceNote });
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
    const { subject_id, center_id, mode, lesson_number, week_number } = req.body;

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

    const normalizedWeekNumber = week_number !== undefined && week_number !== null && week_number !== '' ? Number(week_number) : null;

    const newSession = await Session.create({
      lesson_number: finalLessonNumber,
      week_number: normalizedWeekNumber,
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

    // Also get center students who attended this lesson online
    const onlineAttendances = await Attendance.findAll({
      include: [{
        model: Student,
        where: { CenterId: session.CenterId, SubjectId: session.SubjectId },
      }, {
        model: Session,
        where: { lesson_number: session.lesson_number, SubjectId: session.SubjectId },
        include: [Center],
      }, User],
    });

    // Filter for only those who attended online (not at this center)
    const onlineOnlyAttendances = onlineAttendances.filter(a => 
      a.Session.Center.name === 'أونلاين' && 
      !attendances.some(ca => ca.StudentId === a.StudentId)
    );

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
        payment: getActualSessionPayment(a),
        location: session.Center.name,
        homeworkStatus: hw ? hw.status : null,
        homeworkUser: hw ? hw.user : null,
        homeworkTime: hw ? hw.time : null,
        examScore: exam ? exam.score : null,
        examMax: exam ? exam.max : null,
        examUser: exam ? exam.user : null,
        examTime: exam ? exam.time : null,
      };
    });

    // Add online attendees to the attended rows
    const onlineAttendedRows = onlineOnlyAttendances.map(a => {
      const hw = homeworkMap[a.StudentId];
      const exam = examMap[a.StudentId];
      return {
        attendanceId: a.id,
        student: a.Student,
        attendanceUser: a.User ? a.User.name : '-',
        attendanceTime: a.attended_at,
        comment: a.comment,
        payment: 0,
        location: 'أونلاين',
        homeworkStatus: hw ? hw.status : null,
        homeworkUser: hw ? hw.user : null,
        homeworkTime: hw ? hw.time : null,
        examScore: exam ? exam.score : null,
        examMax: exam ? exam.max : null,
        examUser: exam ? exam.user : null,
        examTime: exam ? exam.time : null,
      };
    });

    // Combine both attended rows
    const allAttendedRows = [...attendedRows, ...onlineAttendedRows];

    let absentStudents = [];
    let onlineAttendees = [];

    if (session.status !== 'cancelled') {
      const groupStudents = await Student.findAll({
        where: { CenterId: session.CenterId, SubjectId: session.SubjectId },
      });

      // Get all attendance for this lesson from any center with center info
      const attendedAnywhere = await Attendance.findAll({
        include: [{
          model: Session,
          where: { lesson_number: session.lesson_number, SubjectId: session.SubjectId },
          include: [Center],
        }],
      });

      // Separate online attendees from regular attendees
      const attendedCenterStudentIds = new Set();
      const onlineAttendeeIds = new Set();
      
      attendedAnywhere.forEach(a => {
        if (a.Session.Center.name === 'أونلاين') {
          onlineAttendeeIds.add(a.StudentId);
        } else {
          attendedCenterStudentIds.add(a.StudentId);
        }
      });

      // Mark as absent only if they didn't attend at their center (online attendance counts as attended)
      absentStudents = groupStudents.filter(s => !attendedCenterStudentIds.has(s.id) && !onlineAttendeeIds.has(s.id));
      
      // Get center students who attended online
      onlineAttendees = groupStudents.filter(s => onlineAttendeeIds.has(s.id) && !attendedCenterStudentIds.has(s.id));
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
    const totalCashCollected = attendances.reduce((sum, a) => sum + getActualSessionPayment(a), 0);

    const assistantAttendances = await AssistantAttendance.findAll({
      where: { SessionId: session.id },
      include: [User],
      order: [['check_in', 'ASC']],
    });
    const allUsers = await User.findAll({ order: [['name', 'ASC']] });

    res.render('session-report', {
      session, attendedRows: allAttendedRows, absentStudents, onlineAttendees,
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

    // Also get center students who attended this lesson online
    const onlineAttendances = await Attendance.findAll({
      include: [{
        model: Student,
        where: { CenterId: session.CenterId, SubjectId: session.SubjectId },
      }, {
        model: Session,
        where: { lesson_number: session.lesson_number, SubjectId: session.SubjectId },
        include: [Center],
      }, User],
    });

    // Filter for only those who attended online (not at this center)
    const onlineOnlyAttendances = onlineAttendances.filter(a => 
      a.Session.Center.name === 'أونلاين' && 
      !attendances.some(ca => ca.StudentId === a.StudentId)
    );

    const homeworkRecords = await HomeworkCheck.findAll({ where: { SessionId: session.id } });
    const homeworkMap = {};
    homeworkRecords.forEach(h => { homeworkMap[h.StudentId] = h.status; });

    // Get homework from previous session (lesson_number - 1 with same subject)
    const previousSessionHomeworkRecords = await HomeworkCheck.findAll({
      include: [{
        model: Session,
        where: {
          lesson_number: session.lesson_number - 1,
          SubjectId: session.SubjectId,
        },
      }],
    });
    const previousHomeworkMap = {};
    previousSessionHomeworkRecords.forEach(h => {
      previousHomeworkMap[h.StudentId] = h.status;
    });

    const linkedExam = await Exam.findOne({ where: { SessionId: session.id } });
    const examMap = {};
    if (linkedExam) {
      const examResults = await ExamResult.findAll({ where: { ExamId: linkedExam.id } });
      examResults.forEach(result => { examMap[result.StudentId] = result.score; });
    }

    const bookletTransactions = await BalanceTransaction.findAll({
      where: {
        SessionId: session.id,
        reason: { [Op.like]: 'دفع بوكليت:%' },
      },
    });
    const bookletPaymentMap = {};
    bookletTransactions.forEach(t => {
      bookletPaymentMap[t.StudentId] = (bookletPaymentMap[t.StudentId] || 0) + Number(t.amount || 0);
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('الحاضرين');

    sheet.columns = [
      { header: 'الكود', key: 'code', width: 15 },
      { header: 'الاسم', key: 'name', width: 25 },
      { header: 'تليفون الطالب', key: 'phone', width: 18 },
      { header: 'تليفون ولي الأمر', key: 'parent_phone', width: 18 },
      { header: 'مكان الحضور', key: 'location', width: 15 },
      { header: 'الواجب', key: 'homework', width: 15 },
      { header: 'الواجب من الحصة السابقة', key: 'previous_homework', width: 18 },
      { header: 'درجة الامتحان', key: 'exam_score', width: 15 },
      { header: 'كومنت', key: 'comment', width: 25 },
      { header: 'دفع وقت الحضور', key: 'payment', width: 15 },
      { header: 'دفع البوكليت', key: 'booklet_payment', width: 15 },
      { header: 'إجمالي دفع البوكليت والحصة', key: 'total_payment', width: 25 },
      { header: 'سجّل الحضور', key: 'user', width: 18 },
    ];

    const homeworkLabels = {
      complete: 'كامل', incomplete: 'مش كامل', no_steps: 'من غير خطوات', not_done: 'مش معمول',
    };

    // Add center attendees
    attendances.forEach(a => {
      sheet.addRow({
        code: a.Student.student_code,
        name: a.Student.name,
        phone: a.Student.phone,
        parent_phone: a.Student.parent_phone,
        location: session.Center.name,
        homework: homeworkLabels[homeworkMap[a.StudentId]] || '-',
        previous_homework: homeworkLabels[previousHomeworkMap[a.StudentId]] || '-',
        exam_score: examMap[a.StudentId] ?? '-',
        comment: a.comment || '-',
        payment: a.payment_collected || 0,
        booklet_payment: bookletPaymentMap[a.StudentId] || 0,
        total_payment: Number(a.payment_collected || 0) + (bookletPaymentMap[a.StudentId] || 0),
        user: a.User ? a.User.name : '-',
      });
    });

    // Add online attendees (if any)
    onlineOnlyAttendances.forEach(a => {
      sheet.addRow({
        code: a.Student.student_code,
        name: a.Student.name,
        phone: a.Student.phone,
        parent_phone: a.Student.parent_phone,
        location: 'أونلاين',
        homework: homeworkLabels[homeworkMap[a.StudentId]] || '-',
        previous_homework: homeworkLabels[previousHomeworkMap[a.StudentId]] || '-',
        exam_score: examMap[a.StudentId] ?? '-',
        comment: a.comment || '-',
        payment: 0,
        booklet_payment: bookletPaymentMap[a.StudentId] || 0,
        total_payment: (bookletPaymentMap[a.StudentId] || 0),
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
    let onlineAttendees = [];

    if (session.status !== 'cancelled') {
      const groupStudents = await Student.findAll({
        where: { CenterId: session.CenterId, SubjectId: session.SubjectId },
      });

      // Get all attendance for this lesson from any center with center info
      const attendedAnywhere = await Attendance.findAll({
        include: [{
          model: Session,
          where: { lesson_number: session.lesson_number, SubjectId: session.SubjectId },
          include: [Center],
        }],
      });

      // Separate online attendees from regular attendees
      const attendedCenterStudentIds = new Set();
      const onlineAttendeeIds = new Set();
      
      attendedAnywhere.forEach(a => {
        if (a.Session.Center.name === 'أونلاين') {
          onlineAttendeeIds.add(a.StudentId);
        } else {
          attendedCenterStudentIds.add(a.StudentId);
        }
      });

      // Mark as absent only if they didn't attend at their center (online attendance counts as attended)
      absentStudents = groupStudents.filter(s => !attendedCenterStudentIds.has(s.id) && !onlineAttendeeIds.has(s.id));
      
      // Get center students who attended online
      onlineAttendees = groupStudents.filter(s => onlineAttendeeIds.has(s.id) && !attendedCenterStudentIds.has(s.id));
    }

    const workbook = new ExcelJS.Workbook();
    
    // Sheet 1: Regular absent students
    const absentSheet = workbook.addWorksheet('الغايبين');
    absentSheet.columns = [
      { header: 'الكود', key: 'code', width: 15 },
      { header: 'الاسم', key: 'name', width: 25 },
      { header: 'تليفون الطالب', key: 'phone', width: 18 },
      { header: 'تليفون ولي الأمر', key: 'parent_phone', width: 18 },
      { header: 'الرصيد الحالي', key: 'balance', width: 15 },
    ];

    absentStudents.forEach(s => {
      absentSheet.addRow({
        code: s.student_code,
        name: s.name,
        phone: s.phone,
        parent_phone: s.parent_phone,
        balance: s.balance,
      });
    });

    absentSheet.getRow(1).font = { bold: true };

    // Sheet 2: Online attendees (center students who attended online)
    if (onlineAttendees.length > 0) {
      const onlineSheet = workbook.addWorksheet('حضور أونلاين');
      onlineSheet.columns = [
        { header: 'الكود', key: 'code', width: 15 },
        { header: 'الاسم', key: 'name', width: 25 },
        { header: 'تليفون الطالب', key: 'phone', width: 18 },
        { header: 'تليفون ولي الأمر', key: 'parent_phone', width: 18 },
        { header: 'ملاحظة', key: 'note', width: 30 },
      ];

      onlineAttendees.forEach(s => {
        onlineSheet.addRow({
          code: s.student_code,
          name: s.name,
          phone: s.phone,
          parent_phone: s.parent_phone,
          note: 'حضر الحصة أونلاين (معوض)',
        });
      });

      onlineSheet.getRow(1).font = { bold: true };
    }

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

// تعديل أسبوع الحصة أو إزالتها من أي أسبوع
app.post('/sessions/:id/update-week', requireAdmin, async (req, res) => {
  try {
    const rawWeek = req.body.week_number;
    const normalizedWeek = rawWeek === undefined || rawWeek === null || rawWeek === '' ? null : Number(rawWeek);

    await Session.update({ week_number: normalizedWeek }, { where: { id: req.params.id } });
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

    if (booklet_status === 'on') {
      const updatedStudent = await Student.findByPk(req.params.id);
      await ensureStudentBookletPlaceholder(updatedStudent);
    }

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

    const isOnlineSession = sessionToDelete.Center.name === 'أونلاين';
    if (!isOnlineSession) {
      const { admin_password } = req.body;
      if (!admin_password) {
        return res.status(400).send('❌ الحذف النهائي متاح فقط لحصص الأونلاين. أدخل كلمة المرور الإدارية لحذف هذه الحصة من السنتر.');
      }
      const verified = await verifyAdminPassword(req.session.userId, admin_password);
      if (!verified) {
        return res.status(403).send('❌ كلمة المرور الإدارية غير صحيحة.');
      }
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
    const {
      name,
      phone,
      parent_phone,
      price_per_session,
      center_id,
      subject_id,
      balance,
      booklet_status,
      booklet_paid_amount,
      register_attendance,
      comment,
    } = req.body;

    const initialBalance = parseFloat(balance) || 0;
    const paidAmount = parseFloat(booklet_paid_amount) || 0;
    const shouldHaveBookletStatus = booklet_status === 'on' || paidAmount > 0;

    const student = await Student.create({
      name,
      phone,
      parent_phone,
      price_per_session,
      balance: initialBalance,
      booklet_status: shouldHaveBookletStatus,
      CenterId: center_id,
      SubjectId: subject_id,
      UserId: req.session.userId,
    });

    if (paidAmount > 0) {
      const booklet = await Booklet.findOne({
        where: { SubjectId: subject_id, is_active: true },
        order: [['order_index', 'ASC']],
      });
      if (booklet) {
        await processBookletPayments(student.id, [{ booklet_id: booklet.id, amount: paidAmount }], req.session.userId, register_attendance === 'on' ? req.session.activeSessionId : null);
      }
    } else if (shouldHaveBookletStatus) {
      await ensureStudentBookletPlaceholder(student);
    }

    let attendanceNote = null;
    if (register_attendance === 'on') {
      const sessionId = req.session.activeSessionId;
      if (!sessionId) {
        attendanceNote = '⚠️ لا توجد حصة شغالة الآن لتسجيل حضور الطالب.';
      } else {
        const activeSession = await Session.findByPk(sessionId);
        if (!activeSession || activeSession.status === 'cancelled') {
          attendanceNote = '⚠️ الحصة الحالية غير متاحة للتسجيل.';
        } else {
          const existingAttendance = await Attendance.findOne({
            where: { StudentId: student.id, SessionId: sessionId },
          });
          if (existingAttendance) {
            attendanceNote = '⚠️ الطالب مسجل حضور في هذه الحصة بالفعل.';
          } else if (student.balance < student.price_per_session) {
            attendanceNote = `⚠️ رصيد الطالب غير كافٍ لتسجيل الحضور (الرصيد: ${student.balance} ج).`;
          } else {
            await recordAttendanceCharge(student, req.session.userId, 'رسوم الحضور');
            await Attendance.create({
              StudentId: student.id,
              SessionId: sessionId,
              UserId: req.session.userId,
              comment: comment || null,
              payment_collected: initialBalance,
            });
            await addPoints(student.id, 2);
            attendanceNote = '✅ تم تسجيل حضور الطالب في الحصة الحالية.';
          }
        }
      }
    }

    const qrCodeImage = await QRCode.toDataURL(student.student_code);
    res.json({ success: true, student, qrCodeImage, attendanceNote });
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
    await syncStudentBookletStatus(student);

    const activeSession = await Session.findByPk(sessionId);
    if (!activeSession) return res.json({ success: false, message: '⚠️ مفيش حصة شغالة' });
    if (activeSession.status === 'cancelled') {
      return res.json({ success: false, message: '⚠️ هذه الحصة ملغية' });
    }
    if (student.SubjectId !== activeSession.SubjectId) {
      return res.json({
        success: false,
        subjectMismatch: true,
        message: `🚨 هذا الطالب تابع لمادة ${student.Subject?.name || 'مختلفة'}، والحصة الحالية لمادة مختلفة`,
      });
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

    const followUpAssistant = await getFollowUpAssistantForStudent(student.id);

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
    await syncStudentBookletStatus(student);
    if (student.booklet_status) {
      await ensureStudentBookletPlaceholder(student, booklets);
    }

    const bookletStatuses = await Promise.all(booklets.map(async (booklet) => {
      const studentBooklet = await StudentBooklet.findOne({
        where: { StudentId: student.id, BookletId: booklet.id },
      });
      const reservation = await BookletReservation.findOne({
        where: { StudentId: student.id, BookletId: booklet.id, status: { [Op.ne]: 'rejected' } },
      });

      const paidAmount = studentBooklet ? studentBooklet.paid_amount : 0;
      const effectivePrice = getEffectiveBookletPrice(booklet, studentBooklet);
      const remaining = Math.max(0, effectivePrice - paidAmount);

      return {
        id: booklet.id,
        name: booklet.name,
        sellPrice: effectivePrice,
        paidAmount,
        remaining,
        studentBookletId: studentBooklet ? studentBooklet.id : null,
        isDelivered: Boolean(studentBooklet && studentBooklet.is_delivered),
        reservationStatus: reservation ? reservation.status : null,
        reservationMethod: reservation ? reservation.payment_method : null,
        isFullyPaid: remaining <= 0,
      };
    }));

    const resolvedBookletStatus = student.booklet_status || bookletStatuses.some(b => b.studentBookletId !== null);

    res.json({
      success: true,
      student: {
        id: student.id,
        name: student.name,
        code: student.student_code,
        balance: student.balance,
        pricePerSession: student.price_per_session,
        adminNote: student.admin_note,
        bookletStatus: resolvedBookletStatus,
      },
      summary,
      bookletStatuses,
      pendingBooklets: bookletStatuses.filter(b => !b.isFullyPaid && !b.isDelivered),
      followUpAssistant,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});

app.post('/attendance/scan', async (req, res) => {
  try {
    const { student_code, comment, payment_collected, booklet_delivered } = req.body;
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
    if (student.SubjectId !== activeSession.SubjectId) {
      return res.json({
        success: false,
        subjectMismatch: true,
        message: '🚨 كود الطالب يخص مادة مختلفة عن مادة الحصة الحالية، لم يتم تسجيل الحضور',
      });
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

    await recordAttendanceCharge(student, req.session.userId, 'رسوم الحضور');
    if (booklet_delivered) {
      await markDefaultBookletDelivered(student);
    }
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
      await processBookletPayments(student.id, req.body.booklet_payments, req.session.userId, sessionId);
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
app.post('/attendance/scan/force', requirePermission('attendance_scan'), async (req, res) => {
  try {
    const { student_code, password } = req.body;
    const sessionId = req.session.activeSessionId;

    if (password !== 'admin123') {
      return res.json({ success: false, message: 'كلمة المرور غير صحيحة' });
    }

    const student = await Student.findOne({ where: { student_code } });
    if (!student) {
      return res.json({ success: false, message: 'كود الطالب غير صحيح' });
    }

    const activeSession = await Session.findByPk(sessionId);
    if (!activeSession || activeSession.status === 'cancelled') {
      return res.json({ success: false, message: '⚠️ الحصة الحالية غير متاحة للتسجيل' });
    }
    if (student.SubjectId !== activeSession.SubjectId) {
      return res.json({
        success: false,
        subjectMismatch: true,
        message: '🚨 كود الطالب يخص مادة مختلفة عن مادة الحصة الحالية، لم يتم تسجيل الحضور',
      });
    }

    const existingAttendance = await Attendance.findOne({ where: { StudentId: student.id, SessionId: sessionId } });
    if (existingAttendance) {
      return res.json({ success: false, message: 'الطالب مسجل حضوره من قبل' });
    }

    await recordAttendanceCharge(student, req.session.userId, 'رسوم الحضور (قوة)');

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

app.post('/exams/:id/delete', requirePermission('exams'), async (req, res) => {
  let transaction;
  try {
    const exam = await Exam.findByPk(req.params.id);
    if (!exam) return res.status(404).send('❌ الامتحان غير موجود');

    transaction = await sequelize.transaction();
    await ExamResult.destroy({ where: { ExamId: exam.id }, transaction });
    await exam.destroy({ transaction });
    await transaction.commit();

    res.redirect('/exams');
  } catch (error) {
    if (transaction) await transaction.rollback();
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

    const homeworkRecords = await HomeworkCheck.findAll({
      where: { StudentId: student.id },
      include: [{ model: Session, include: [Center] }],
    });
    const homeworkMap = {};
    homeworkRecords.forEach(h => {
      if (h.Session && h.Session.SubjectId === student.SubjectId) {
        homeworkMap[h.Session.lesson_number] = h.status;
      }
    });

    const homeworkLabels = {
      complete: 'كامل', incomplete: 'مش كامل', no_steps: 'من غير خطوات', not_done: 'مش معمول',
    };

    const summary = attendanceRecords
      .filter(a => a.Session.SubjectId === student.SubjectId)
      .map(a => ({
        lessonNumber: a.Session.lesson_number,
        centerName: a.Session.Center.name,
        homeworkStatus: homeworkMap[a.Session.lesson_number] ? homeworkLabels[homeworkMap[a.Session.lesson_number]] : 'لم يصحح',
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

    const student = await Student.findOne({ where: { student_code } });
    if (!student) {
      return res.json({ success: false, message: 'كود الطالب غير صحيح' });
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

    const currentSession = await Session.findByPk(sessionId, {
      attributes: ['lesson_number', 'CenterId', 'SubjectId'],
    });
    let attendance = await Attendance.findOne({ where: { StudentId: student.id, SessionId: sessionId } });
    if (!attendance && currentSession) {
      const equivalentSessions = await Session.findAll({
        attributes: ['id'],
        where: {
          lesson_number: currentSession.lesson_number,
          SubjectId: currentSession.SubjectId,
          CenterId: { [Op.ne]: currentSession.CenterId },
        },
      });
      if (equivalentSessions.length > 0) {
        attendance = await Attendance.findOne({
          where: {
            StudentId: student.id,
            SessionId: equivalentSessions.map(session => session.id),
          },
        });
      }
    }
    const previousSession = currentSession && currentSession.lesson_number > 1
      ? await Session.findOne({
        where: {
          lesson_number: currentSession.lesson_number - 1,
          CenterId: currentSession.CenterId,
          SubjectId: currentSession.SubjectId,
        },
        order: [['id', 'DESC']],
      })
      : null;
    const homework = previousSession
      ? await HomeworkCheck.findOne({ where: { StudentId: student.id, SessionId: previousSession.id } })
      : null;

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
    const { name, username, password, role, phone } = req.body;

    const existing = await User.findOne({ where: { username } });
    if (existing) {
      return res.status(400).send('❌ اليوزرنيم ده مستخدم بالفعل، اختار يوزرنيم تاني');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await User.create({
      name,
      username,
      phone: phone || null,
      password: hashedPassword,
      role,
    });

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

    const targetUserId = Number(req.params.id);

    await FollowUpAssignment.destroy({ where: { AssistantId: targetUserId } });
    await User.destroy({ where: { id: targetUserId } });

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
      consecutive_absent_sessions: 3,
      consecutive_poor_homework_sessions: 3,
      consecutive_low_exam_attempts: 3,
      low_exam_score: 50,
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
          attributes: ['lesson_number', 'SubjectId'],
        }],
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

      const studentAttendance = (attendanceByStudent[student.id] || [])
        .filter(a => a.Session.SubjectId === student.SubjectId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      const ownGroupSessions = allSessions
        .filter(sess => sess.CenterId === student.CenterId && sess.SubjectId === student.SubjectId && sess.status === 'normal')
        .sort((a, b) => b.lesson_number - a.lesson_number);

      const recentSessionsForAbsence = ownGroupSessions.slice(0, THRESHOLDS.consecutive_absent_sessions);
      const attendedSessionIds = new Set(studentAttendance.map(a => a.SessionId));

      const absent3 = recentSessionsForAbsence.length === THRESHOLDS.consecutive_absent_sessions &&
        recentSessionsForAbsence.every(sess => !attendedSessionIds.has(sess.id));

      if (absent3) {
        reasons.push(`🔴 غياب في آخر ${THRESHOLDS.consecutive_absent_sessions} حصص متتالية`);
        flags.absentSessions = true;
        riskScore += 50;
      }

      const recentSessionsForHomework = ownGroupSessions.slice(0, THRESHOLDS.consecutive_poor_homework_sessions);
      const poorHomework3 = recentSessionsForHomework.length === THRESHOLDS.consecutive_poor_homework_sessions &&
        recentSessionsForHomework.every(sess => {
          const status = homeworkByKey[`${student.id}_${sess.id}`];
          return status !== 'complete';
        });

      if (poorHomework3) {
        reasons.push(`🟠 واجبات غير مكتملة في آخر ${THRESHOLDS.consecutive_poor_homework_sessions} حصص`);
        flags.poorHomework = true;
        riskScore += 40;
      }

      const studentExams = (examResultsByStudent[student.id] || [])
        .filter(e => e.Exam && e.Exam.Session && e.Exam.Session.SubjectId === student.SubjectId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      const recentExamResults = studentExams.slice(0, THRESHOLDS.consecutive_low_exam_attempts);
      const lowExam3 = recentExamResults.length === THRESHOLDS.consecutive_low_exam_attempts &&
        recentExamResults.every(e => ((e.score / e.Exam.max_score) * 100) < THRESHOLDS.low_exam_score);

      if (lowExam3) {
        reasons.push(`📉 آخر ${THRESHOLDS.consecutive_low_exam_attempts} امتحانات أقل من ${THRESHOLDS.low_exam_score}%`);
        flags.lowExamScores = true;
        riskScore += 40;
      }

      let severity = 'safe';
      if (riskScore >= 75) severity = 'critical';
      else if (riskScore >= 50) severity = 'warning';
      else if (riskScore >= 25) severity = 'caution';

      const statistics = {
        attendanceRate: ownGroupSessions.length > 0 ? Math.round(((ownGroupSessions.length - recentSessionsForAbsence.filter(sess => !attendedSessionIds.has(sess.id)).length) / ownGroupSessions.length) * 100) : 0,
        homeworkQuality: recentSessionsForHomework.length > 0
          ? Math.round(((recentSessionsForHomework.filter(sess => homeworkByKey[`${student.id}_${sess.id}`] === 'complete').length) / recentSessionsForHomework.length) * 100)
          : 0,
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

      const activeWarnings = (warningsByStudent[student.id] || [])
        .filter(w => {
          const daysSince = (Date.now() - new Date(w.createdAt)) / (1000 * 60 * 60 * 24);
          return daysSince < 30;
        });

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
function hasAllVideoAccess(student) {
  return student.student_code === 'STU-00000';
}

async function cleanupStaleVideoAccessGrants(studentId, sessionId = null) {
  const where = { StudentId: studentId };
  if (sessionId !== null) {
    where.SessionId = sessionId;
  }

  const grants = await VideoAccessGrant.findAll({ where });
  const staleGrantIds = [];

  for (const grant of grants) {
    if (grant.method !== 'attended') continue;

    if (!grant.SessionId) {
      staleGrantIds.push(grant.id);
      continue;
    }

    const hasValidAttendance = await Attendance.findOne({
      where: { StudentId: studentId, SessionId: grant.SessionId },
    });

    if (!hasValidAttendance) {
      staleGrantIds.push(grant.id);
    }
  }

  if (staleGrantIds.length > 0) {
    await VideoAccessGrant.destroy({ where: { id: staleGrantIds } });
  }

  if (sessionId !== null) {
    const sessionGrants = await VideoAccessGrant.findAll({ where: { StudentId: studentId, SessionId: sessionId } });
    if (sessionGrants.length > 1) {
      const sorted = [...sessionGrants].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const keepId = sorted[0].id;
      const extras = sorted.slice(1).map(g => g.id);
      if (extras.length > 0) {
        await VideoAccessGrant.destroy({ where: { id: extras, StudentId: studentId, SessionId: sessionId } });
      }
      if (keepId !== sorted[0].id) {
        // kept by sort above; no-op
      }
    }
  }
}

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

  const ownSessionIds = new Set(ownSessions.map(s => s.id));

  const attendanceRecords = await Attendance.findAll({
    where: { StudentId: student.id },
    include: [{ model: Session, include: [Center] }, User],
  });
  const attendanceByLesson = {};
  attendanceRecords.forEach(a => {
    if (a.Session && a.Session.SubjectId === student.SubjectId) {
      const key = Number(a.Session.lesson_number);
      const current = attendanceByLesson[key];
      const isPreferredSession = ownSessionIds.has(a.SessionId);
      const currentPreferred = current && current.SessionId && ownSessionIds.has(current.SessionId);
      if (!current || (isPreferred && !currentPreferred) || (!current.SessionId && a.SessionId)) {
        attendanceByLesson[key] = a;
      }
    }
  });

  const homeworkRecords = await HomeworkCheck.findAll({
    where: { StudentId: student.id },
    include: [{ model: Session, include: [Center] }, User],
  });
  const homeworkByLesson = {};
  homeworkRecords.forEach(h => {
    if (h.Session && h.Session.SubjectId === student.SubjectId) {
      const key = Number(h.Session.lesson_number);
      const current = homeworkByLesson[key];
      const isPreferredSession = ownSessionIds.has(h.SessionId);
      const currentPreferred = current && current.SessionId && ownSessionIds.has(current.SessionId);
      if (!current || (isPreferred && !currentPreferred) || (!current.SessionId && h.SessionId)) {
        homeworkByLesson[key] = h;
      }
    }
  });

  const examResults = await ExamResult.findAll({
    where: { StudentId: student.id },
    include: [{ model: Exam, include: [Session] }, User],
  });
  const examByLesson = {};
  examResults.forEach(r => {
    if (r.Exam.Session) {
      const key = Number(r.Exam.Session.lesson_number);
      const current = examByLesson[key];
      const isPreferredSession = ownSessionIds.has(r.Exam.SessionId);
      const currentPreferred = current && current.Exam && current.Exam.SessionId && ownSessionIds.has(current.Exam.SessionId);
      if (!current || (isPreferred && !currentPreferred) || (!current.Exam?.SessionId && r.Exam.SessionId)) {
        examByLesson[key] = r;
      }
    }
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
      attendedCenterName = att.Session?.Center?.name || null;
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
      profilePhotoUrl: student.profile_photo_url,
      isBlocked: student.is_blocked,
      points: student.points,
      warnings: warnings.map(w => ({ reason: w.reason, time: w.createdAt })),
      followUpAssistant: await getFollowUpAssistantForStudent(student.id),
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
    if (!student) return res.status(404).json({ success: false, message: 'غير موجود' });
    const allVideoAccess = hasAllVideoAccess(student);

    // نجيب الفيديوهات المتاحة للطالب:
    // 1) فيديوهات مرتبطة بحصة من مجموعته (عبر VideoSession)
    // 2) فيديوهات له وصول فردي فيها

    // حصص مجموعة الطالب
    const studentSessions = allVideoAccess ? [] : await Session.findAll({
      where: { SubjectId: student.SubjectId, CenterId: student.CenterId },
    });
    const studentSessionIds = studentSessions.map(s => s.id);

    // الفيديوهات المرتبطة بحصص مجموعته
    const groupVideoSessions = await VideoSession.findAll({
      where: { SessionId: studentSessionIds },
      attributes: ['VideoId'],
    });
    const directlyLinkedVideos = studentSessionIds.length > 0 ? await Video.findAll({
      where: { SessionId: studentSessionIds },
      attributes: ['id'],
    }) : [];
    const groupVideoIds = [...new Set([
      ...groupVideoSessions.map(vs => vs.VideoId),
      ...directlyLinkedVideos.map(video => video.id),
    ])];

    // الفيديوهات التي له وصول فردي
    const individualAccesses = await VideoStudentAccess.findAll({
      where: { StudentId: student.id },
      attributes: ['VideoId'],
    });
    const individualVideoIds = individualAccesses.map(a => a.VideoId);

    // دمج الاتنين بدون تكرار
    const allAccessibleVideoIds = allVideoAccess
      ? null
      : [...new Set([...groupVideoIds, ...individualVideoIds])];

    if (!allVideoAccess && allAccessibleVideoIds.length === 0) return res.json({ success: true, lessons: [] });

    const videos = await Video.findAll({
      ...(allVideoAccess ? {} : { where: { id: allAccessibleVideoIds } }),
      include: [
        { model: Session, required: false, include: [Center] },
        { model: VideoSession, required: false, include: [Session] },
      ],
      order: [['createdAt', 'DESC']],
    });

    const attendanceRecords = await Attendance.findAll({
      where: { StudentId: student.id },
      attributes: ['SessionId'],
    });
    const attendedSessionIds = new Set(attendanceRecords.map(a => a.SessionId).filter(Boolean));

    await cleanupStaleVideoAccessGrants(student.id);

    const grants = await VideoAccessGrant.findAll({ where: { StudentId: student.id } });
    const cleanedGrants = [];

    for (const grant of grants) {
      if (grant.method === 'attended' && !attendedSessionIds.has(grant.SessionId)) {
        await grant.destroy();
        continue;
      }
      cleanedGrants.push(grant);
    }

    const grantBySessionId = {};
    cleanedGrants.forEach(g => { if (g.SessionId) grantBySessionId[g.SessionId] = g; });

    const lessons = videos.map(v => {
      const session = v.Session || v.VideoSessions?.map(videoSession => videoSession.Session).find(Boolean);
      if (!session) return null;

      const grant = session ? grantBySessionId[session.id] : null;
      let status, viewsUsed = 0, maxViews = 0;

      if (allVideoAccess) {
        status = 'free';
      } else if (session.is_free_for_all) {
        status = 'free';
      } else if (grant) {
        const isValidGrant = grant.method === 'paid' || grant.method === 'admin_free' || grant.method === 'admin_paid' || (grant.method === 'attended' && attendedSessionIds.has(session.id));
        if (!isValidGrant) {
          status = 'locked';
        } else {
          status = grant.views_used >= grant.max_views ? 'exhausted' : 'granted';
          viewsUsed = grant.views_used;
          maxViews = grant.max_views;
        }
      } else {
        status = 'locked';
      }

      return {
        videoId: v.id,
        title: v.title,
        lessonNumber: session ? session.lesson_number : null,
        weekNumber: session ? (session.week_number ?? null) : null,
        date: session ? session.session_date : null,
        status,
        viewsUsed,
        maxViews,
        price: student.price_per_session,
        homeworkVideoUrl: session && session.homework_video_url ? session.homework_video_url : null,
        examUrl: session && session.exam_url ? session.exam_url : null,
      };
    }).filter(Boolean);

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
    if (!student) return res.status(404).json({ success: false });
    const allVideoAccess = hasAllVideoAccess(student);
    const video = await Video.findOne({
      where: { id: req.params.videoId },
      include: [
        { model: Session, required: false },
        { model: VideoSession, required: false, include: [Session] },
      ],
    });
    if (!video) return res.status(404).json({ success: false, message: 'الدرس غير موجود' });

    const session = video.Session || video.VideoSessions?.map(videoSession => videoSession.Session).find(Boolean);
    if (!session && !allVideoAccess) return res.status(404).json({ success: false, message: 'الحصة المرتبطة بالدرس غير موجودة' });

    if (allVideoAccess) {
      return res.json({ success: true, unlimited: true });
    }

    // 1) الحالة المجانية للجميع - فتح فوري بلا حدود + تسجيل حضور
    if (session.is_free_for_all) {
      await ensureAttendance(student.id, session.id, '📹 حضر الحصة (مفتوحة مجانًا للجميع)');
      return res.json({ success: true, unlimited: true });
    }

    // 2) فيه صلاحية مسجلة بالفعل (حضور سابق / دفع سابق / فتح أدمن)
    const attendanceExists = await Attendance.findOne({ where: { StudentId: student.id, SessionId: session.id } });
    await cleanupStaleVideoAccessGrants(student.id, session.id);
    let grant = await VideoAccessGrant.findOne({ where: { StudentId: student.id, SessionId: session.id } });

    if (grant && grant.method === 'attended' && !attendanceExists) {
      await VideoAccessGrant.destroy({ where: { StudentId: student.id, SessionId: session.id, method: 'attended' } });
      grant = null;
    }

    if (grant) {
      const isValidGrant = grant.method === 'paid' || grant.method === 'admin_free' || grant.method === 'admin_paid' || (grant.method === 'attended' && attendanceExists);
      if (!isValidGrant) {
        grant = null;
      } else if (grant.views_used >= grant.max_views) {
        return res.json({ success: false, message: 'لقد استهلكت كل مرات المشاهدة المتاحة لهذا الدرس' });
      } else {
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
    }

    // تحقق من الوصول الفردي (student-specific access)
    const individualAccess = await VideoStudentAccess.findOne({
      where: { VideoId: req.params.videoId, StudentId: student.id },
    });
    if (individualAccess && !grant) {
      grant = await VideoAccessGrant.create({
        StudentId: student.id,
        SessionId: session.id,
        method: 'admin_free',
        max_views: 999,
        views_used: 1,
      });
      await ensureAttendance(student.id, video.SessionId, '📹 وصول فردي مخصص من الأدمن');
      return res.json({ success: true, viewsUsed: 1, maxViews: 999 });
    }

    // 3) مفيش صلاحية - نتحقق هل حضر هذه الحصة في أي سنتر فعلي (غير أونلاين)
    const attendedInCenter = await Attendance.findOne({
      where: { StudentId: student.id, SessionId: session.id },
      include: [{
        model: Session,
        include: [{ model: Center }],
      }],
    });

    if (attendedInCenter && attendedInCenter.Session && attendedInCenter.Session.Center && attendedInCenter.Session.Center.name !== 'أونلاين') {
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
    if (!student) return res.status(404).json({ success: false });
    const allVideoAccess = hasAllVideoAccess(student);
    const video = await Video.findOne({
      where: { id: req.params.videoId },
      include: [
        { model: Session, required: false },
        { model: VideoSession, required: false, include: [Session] },
      ],
    });
    if (!video) return res.status(404).json({ success: false });

    const session = video.Session || video.VideoSessions?.map(videoSession => videoSession.Session).find(Boolean);
    if (!session && !allVideoAccess) return res.status(404).json({ success: false, message: 'الحصة المرتبطة بالدرس غير موجودة' });

    // تأكيد إن عنده صلاحية فعلية (مجاني، أو غرانت فيه مشاهدات متاحة، أو حضور فعلي حالي)
    if (!allVideoAccess && !session.is_free_for_all) {
      const grant = await VideoAccessGrant.findOne({ where: { StudentId: student.id, SessionId: session.id } });
      const attendanceExists = await Attendance.findOne({ where: { StudentId: student.id, SessionId: session.id } });
      const isValidGrant = !!(grant && (
        grant.method === 'paid' ||
        grant.method === 'admin_free' ||
        grant.method === 'admin_paid' ||
        (grant.method === 'attended' && attendanceExists)
      ));
      if (!isValidGrant && !attendanceExists) return res.status(403).json({ success: false, message: 'غير مسموح' });
    }

    const parts = await VideoPart.findAll({ where: { VideoId: video.id }, order: [['order_index', 'ASC']] });
    const watchRecords = await WatchProgress.findAll({ where: { StudentId: student.id } });
    const watchMap = {};
    watchRecords.forEach(w => { watchMap[w.VideoPartId] = w.watched_seconds; });

    const grouped = { explanation: [], questions: [], homework_solution: [] };
    parts.forEach(p => {
      const normalizedCategory = ['explanation', 'questions', 'homework_solution'].includes(p.category)
        ? p.category
        : (p.category === 'homework' || p.category === 'homework_solution' ? 'homework_solution' : 'explanation');

      if (!grouped[normalizedCategory]) {
        grouped[normalizedCategory] = [];
      }

      grouped[normalizedCategory].push({
        id: p.id,
        orderIndex: p.order_index,
        sourceType: p.source_type,
        videoUrl: p.video_url,
        filePath: p.file_path,
        durationSeconds: p.duration_seconds,
        watchedSeconds: watchMap[p.id] || 0,
      });
    });

    const availableCategories = Object.keys(grouped).filter(category => grouped[category].length > 0);

    res.json({ success: true, title: video.title, parts: grouped, availableCategories });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
  }
});
//comment
// ===== إدارة الفيديوهات (أدمن بس) =====

app.get('/admin/videos', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  const allSessions = await Session.findAll({ include: [Center, Subject], order: [['createdAt', 'DESC']] });
  const videos = await Video.findAll({
    include: [{ model: Session, required: true, include: [Center, Subject] }], // required: true يستبعد أي فيديو مالوش حصة مرتبطة
    order: [['createdAt', 'DESC']],
  });
  res.render('manage-videos', { allSessions, videos });
});

app.post('/admin/videos/create', requirePermissionOrAdmin('admin_videos'), imageUpload.single('session_image'), async (req, res) => {
  let transaction;
  try {
    const { title } = req.body;
    const submittedSessionIds = req.body.session_ids ?? req.body['session_ids[]'];
    const sessionIdList = (Array.isArray(submittedSessionIds)
      ? submittedSessionIds
      : (submittedSessionIds ? [submittedSessionIds] : []))
      .map(sessionId => Number(sessionId))
      .filter(sessionId => Number.isInteger(sessionId) && sessionId > 0);
    if (sessionIdList.length === 0) return res.status(400).send('❌ اختر حصة واحدة على الأقل');

    const uniqueSessionIds = [...new Set(sessionIdList)];
    const selectedSessions = await Session.findAll({ where: { id: uniqueSessionIds } });
    if (selectedSessions.length !== uniqueSessionIds.length) {
      return res.status(400).send('❌ إحدى الحصص المختارة غير موجودة');
    }

    const firstSession = selectedSessions.find(session => session.id === uniqueSessionIds[0]);
    if (!firstSession) return res.status(404).send('❌ الحصة غير موجودة');

    transaction = await sequelize.transaction();
    if (req.file) {
      await Session.update({ image_path: `/uploads/session-images/${req.file.filename}` }, { where: { id: firstSession.id }, transaction });
    }

    const video = await Video.create({ title, SubjectId: firstSession.SubjectId, SessionId: firstSession.id }, { transaction });

    // ربط الفيديو بكل الحصص المختارة
    await VideoSession.bulkCreate(
      uniqueSessionIds.map(SessionId => ({ VideoId: video.id, SessionId })),
      { transaction },
    );

    await transaction.commit();
    transaction = null;

    res.redirect('/admin/videos');
  } catch (error) {
    if (transaction) await transaction.rollback();
    console.error(error);
    res.status(500).send('❌ حصلت مشكلة: ' + error.message);
  }
});


// إضافة حصة لفيديو موجود
app.post('/admin/videos/:id/add-session', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  try {
    const { session_id } = req.body;
    await VideoSession.findOrCreate({
      where: { VideoId: req.params.id, SessionId: parseInt(session_id) },
    });
    res.redirect('/admin/videos/' + req.params.id + '/access');
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// حذف حصة من فيديو
app.post('/admin/videos/:videoId/remove-session/:sessionId', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  await VideoSession.destroy({ where: { VideoId: req.params.videoId, SessionId: req.params.sessionId } });
  res.redirect('/admin/videos/' + req.params.videoId + '/access');
});

// إضافة وصول فردي لطالب بكوده
app.post('/admin/videos/:id/add-student-access', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  try {
    const { student_code } = req.body;
    const student = await Student.findOne({ where: { student_code: student_code.trim().toUpperCase() } });
    if (!student) return res.status(404).send('❌ الطالب غير موجود');
    await VideoStudentAccess.findOrCreate({ where: { VideoId: req.params.id, StudentId: student.id } });
    res.redirect('/admin/videos/' + req.params.id + '/access');
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// حذف وصول فردي
app.post('/admin/videos/:videoId/remove-student-access/:accessId', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  await VideoStudentAccess.destroy({ where: { id: req.params.accessId } });
  res.redirect('/admin/videos/' + req.params.videoId + '/access');
});


app.get('/admin/videos/:id', requirePermissionOrAdmin('admin_videos'), async (req, res) => {
  const video = await Video.findOne({
    where: { id: req.params.id },
    include: [{ model: Session, include: [Center, Subject] }],
  });
  if (!video) return res.status(404).send('❌ غير موجود');

  const videoParts = await VideoPart.findAll({ where: { VideoId: video.id }, order: [['order_index', 'ASC']] });

  // كل الحصص المرتبطة بالفيديو
  const videoSessions = await VideoSession.findAll({
    where: { VideoId: video.id },
    include: [{ model: Session, include: [Center, Subject] }],
  });

  // الوصول الفردي
  const studentAccesses = await VideoStudentAccess.findAll({
    where: { VideoId: video.id },
    include: [{ model: Student, include: [Subject, Center] }],
  });

  // كل الحصص للاختيار منها
  const allSessions = await Session.findAll({
    include: [Center, Subject],
    order: [['lesson_number', 'ASC']],
    limit: 200,
  });

  res.render('manage-video-parts', { video, videoParts, videoSessions, studentAccesses, allSessions });
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
    const video = await Video.findByPk(req.params.id);
    if (!video) return res.status(404).send('❌ الفيديو غير موجود');

    const videoParts = await VideoPart.findAll({
      attributes: ['id'],
      where: { VideoId: video.id },
    });
    const videoPartIds = videoParts.map(part => part.id);

    if (videoPartIds.length > 0) {
      await WatchProgress.destroy({ where: { VideoPartId: videoPartIds } });
    }
    await VideoPart.destroy({ where: { VideoId: video.id } });
    await VideoSession.destroy({ where: { VideoId: video.id } });
    await VideoStudentAccess.destroy({ where: { VideoId: video.id } });
    await VideoAccessGrant.destroy({ where: { SessionId: video.SessionId } });
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

  const videoSessions = await VideoSession.findAll({
    where: { VideoId: video.id },
    include: [{ model: Session, include: [Center, Subject] }],
  });

  const sessionPairs = new Map();
  if (video.Session) {
    sessionPairs.set(`${video.Session.SubjectId}-${video.Session.CenterId}`, {
      SubjectId: video.Session.SubjectId,
      CenterId: video.Session.CenterId,
    });
  }

  videoSessions.forEach(vs => {
    const session = vs.Session;
    if (session) {
      sessionPairs.set(`${session.SubjectId}-${session.CenterId}`, {
        SubjectId: session.SubjectId,
        CenterId: session.CenterId,
      });
    }
  });

  const sessionConditions = Array.from(sessionPairs.values());
  const sessionStudents = sessionConditions.length > 0
    ? await Student.findAll({
        where: { [Op.or]: sessionConditions },
        include: [Subject, Center],
        order: [['name', 'ASC']],
      })
    : [];

  const manualAccesses = await VideoStudentAccess.findAll({
    where: { VideoId: video.id },
    include: [{ model: Student, include: [Subject, Center] }],
  });

  const manualAccessMap = {};
  const studentIds = new Set(sessionStudents.map(s => s.id));
  manualAccesses.forEach(access => {
    if (access.Student) {
      studentIds.add(access.Student.id);
      manualAccessMap[access.Student.id] = true;
    }
  });

  const students = studentIds.size > 0
    ? await Student.findAll({
        where: { id: [...studentIds] },
        include: [Subject, Center],
        order: [['name', 'ASC']],
      })
    : [];

  const grants = await VideoAccessGrant.findAll({
    where: {
      SessionId: videoSessions.map(vs => vs.SessionId).concat(video.SessionId).filter(Boolean),
    },
  });
  const grantsMap = {};
  grants.forEach(g => { grantsMap[g.StudentId] = g; });

  const allSessions = await Session.findAll({
    include: [Center, Subject],
    order: [['lesson_number', 'ASC']],
    limit: 200,
  });

  res.render('video-access-control', {
    video,
    students,
    grantsMap,
    manualAccessMap,
    videoSessions,
    allSessions,
  });
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

    await VideoAccessGrant.destroy({
      where: {
        StudentId: studentId,
        SessionId: sessionId,
        method: 'attended',
      },
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
const HomeworkAssignmentSession = require('./models/HomeworkAssignmentSession');

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

app.get('/hw/assignments', requirePermission('homework_online'), async (req, res) => {
  const { subject_id, center_id, session_id, q } = req.query;
  const assignments = await HomeworkAssignment.findAll({
    include: [
      { model: require('./models/Subject'), required: false },
      { model: require('./models/Session'), required: false, include: [Center, Subject] },
      { model: Session, as: 'LinkedSessions', required: false, include: [Center, Subject] },
    ],
    order: [['order_number', 'ASC']],
  });
  const subjects = await Subject.findAll();
  const centers = await Center.findAll({ order: [['name', 'ASC']] });
  const sessions = await Session.findAll({ include: [Center, Subject], order: [['lesson_number', 'ASC']], limit: 100 });

  const filteredAssignments = assignments.filter(a => {
    if (subject_id && String(a.SubjectId) !== String(subject_id)) return false;

    if (q) {
      const term = q.toLowerCase();
      const title = String(a.title || '').toLowerCase();
      const desc = String(a.description || '').toLowerCase();
      if (!title.includes(term) && !desc.includes(term)) return false;
    }

    if (center_id) {
      const centersForAssignment = new Set();
      if (a.Session && a.Session.CenterId) centersForAssignment.add(String(a.Session.CenterId));
      if (a.LinkedSessions) a.LinkedSessions.forEach(s => s.CenterId && centersForAssignment.add(String(s.CenterId)));
      if (!centersForAssignment.has(String(center_id))) return false;
    }

    if (session_id) {
      const sessionIds = new Set();
      if (a.SessionId) sessionIds.add(String(a.SessionId));
      if (a.LinkedSessions) a.LinkedSessions.forEach(s => sessionIds.add(String(s.id)));
      if (!sessionIds.has(String(session_id))) return false;
    }

    return true;
  });

  res.render('hw-assignments', {
    assignments: filteredAssignments,
    subjects,
    sessions,
    centers,
    filters: { subject_id, center_id, session_id, q },
  });
});

app.post('/hw/assignments/create', requirePermission('homework_online'), async (req, res) => {
  try {
    const { title, description, order_number, start_date, end_date, subject_id, session_ids, show_for_all } = req.body;
    const sessionIdList = Array.isArray(session_ids)
      ? session_ids.filter(Boolean)
      : (session_ids ? [session_ids] : []);
    const uniqueSessionIds = [...new Set(sessionIdList.map(id => Number(id)).filter(id => Number.isInteger(id)))];
    const showForAll = show_for_all === '1' || show_for_all === 'on';

    const assignment = await HomeworkAssignment.create({
      title,
      description,
      order_number,
      start_date,
      end_date,
      SubjectId: subject_id || null,
      SessionId: uniqueSessionIds.length ? uniqueSessionIds[0] : null,
      show_for_all: showForAll,
    });

    const linkedSessionIds = uniqueSessionIds.filter(id => id !== assignment.SessionId);
    if (linkedSessionIds.length) {
      await HomeworkAssignmentSession.bulkCreate(
        linkedSessionIds.map(sessionId => ({ HomeworkAssignmentId: assignment.id, SessionId: sessionId }))
      );
    }

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

app.post('/hw/submissions/:id/delete', requireAdmin, async (req, res) => {
  try {
    const submission = await HomeworkSubmission.findByPk(req.params.id);
    if (!submission) return res.status(404).send('❌ غير موجود');

    const submissionPaths = JSON.parse(submission.images || '[]');
    const otherSubmissions = await HomeworkSubmission.findAll({
      where: { id: { [Op.ne]: submission.id } },
      attributes: ['images'],
    });
    const sharedPaths = new Set(
      otherSubmissions.flatMap(other => JSON.parse(other.images || '[]'))
    );
    const deletablePaths = submissionPaths.filter(submissionPath =>
      typeof submissionPath === 'string' &&
      !sharedPaths.has(submissionPath) &&
      /^homework_images\/[A-Za-z0-9._-]+$/i.test(submissionPath)
    );
    const deleteToken = process.env.HOMEWORK_UPLOAD_DELETE_TOKEN;
    if (!deleteToken) throw new Error('HOMEWORK_UPLOAD_DELETE_TOKEN غير مضبوط');

    const deleteResponse = await fetch('https://shadyelsharkawy.com/upload.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Homework-Delete-Token': deleteToken,
      },
      body: JSON.stringify({ action: 'delete', paths: deletablePaths }),
    });
    const deleteBody = await deleteResponse.text();
    let deleteResult;
    try {
      deleteResult = JSON.parse(deleteBody);
    } catch {
      throw new Error(`الاستضافة لم ترجع JSON (HTTP ${deleteResponse.status})`);
    }
    if (!deleteResponse.ok || !deleteResult.success) {
      throw new Error(deleteResult.message || 'فشل حذف الملفات من الاستضافة');
    }

    await submission.destroy();
    res.redirect(`/hw/assignments/${submission.HomeworkAssignmentId}`);
  } catch (e) {
    console.error(e);
    res.status(500).send(`❌ حصلت مشكلة في حذف التسليم: ${e.message}`);
  }
});

// --- صفحة تفاصيل واجب (الطلاب الي سلموا + الي مسلموش) ---

app.get('/hw/assignments/:id', requirePermission('homework_online'), async (req, res) => {
  const { student_search, show_all_students, marked_filter } = req.query;
  const showAllStudents = show_all_students === '1' || show_all_students === 'on';
  const assignment = await HomeworkAssignment.findByPk(req.params.id, {
    include: [
      { model: require('./models/Subject'), required: false },
      { model: require('./models/Session'), required: false, include: [Center, Subject] },
      { model: Session, as: 'LinkedSessions', required: false, include: [Center, Subject] },
    ],
  });
  if (!assignment) return res.status(404).send('❌ غير موجود');

  let assignedStudentIds = null;
  if (req.session.userRole !== 'admin' && ['assistant', 'follow_up'].includes(req.session.userRole)) {
    const assistantAssignments = await FollowUpAssignment.findAll({
      where: { AssistantId: req.session.userId },
      attributes: ['StudentId'],
    });
    assignedStudentIds = assistantAssignments.map(a => a.StudentId);
  }

  const assignmentSessionIds = [
    ...(assignment.SessionId ? [assignment.SessionId] : []),
    ...(assignment.LinkedSessions || []).map(s => s.id),
  ].filter(Boolean);

  const submissionsWhere = { HomeworkAssignmentId: req.params.id };
  if (assignedStudentIds !== null && !showAllStudents) {
    submissionsWhere.StudentId = assignedStudentIds.length ? assignedStudentIds : -1;
  }

  let submissions = await HomeworkSubmission.findAll({
    where: submissionsWhere,
    include: [{ model: Student, include: [Center, Subject] }],
  });

  const studentWhere = {};
  if (assignment.SubjectId) studentWhere.SubjectId = assignment.SubjectId;
  if (assignmentSessionIds.length) {
    const centerIds = [...new Set((assignment.Session ? [assignment.Session.CenterId] : []).concat((assignment.LinkedSessions || []).map(s => s.CenterId)).filter(Boolean))];
    if (centerIds.length) studentWhere.CenterId = centerIds;
  }
  if (assignedStudentIds !== null && !showAllStudents) {
    studentWhere.id = assignedStudentIds.length ? assignedStudentIds : -1;
  }

  let notSubmittedAndNotGraded = [];
  if (assignment.SubjectId || assignmentSessionIds.length || assignedStudentIds !== null) {
    let allStudents = await Student.findAll({ where: studentWhere, include: [Center] });
    const submittedStudentIds = submissions.map(s => s.StudentId);

    if (student_search) {
      const searchTerm = student_search.toLowerCase();
      allStudents = allStudents.filter(student =>
        String(student.name || '').toLowerCase().includes(searchTerm) ||
        String(student.student_code || '').toLowerCase().includes(searchTerm)
      );
      submissions = submissions.filter(submission =>
        String(submission.Student.name || '').toLowerCase().includes(searchTerm) ||
        String(submission.Student.student_code || '').toLowerCase().includes(searchTerm)
      );
    }

    for (const student of allStudents) {
      if (submittedStudentIds.includes(student.id)) continue;
      let hwStatus = null;
      if (assignmentSessionIds.length) {
        const hw = await HomeworkCheck.findOne({ where: { StudentId: student.id, SessionId: assignmentSessionIds } });
        hwStatus = hw ? hw.status : null;
      }
      if (!hwStatus) notSubmittedAndNotGraded.push(student);
    }
  }

  if (marked_filter === 'marked') {
    submissions = submissions.filter(sub => sub.status !== 'submitted');
    notSubmittedAndNotGraded = [];
  } else if (marked_filter === 'not_marked') {
    submissions = submissions.filter(sub => sub.status === 'submitted');
  }

  res.render('hw-assignment-detail', {
    assignment,
    submissions,
    notSubmittedAndNotGraded,
    assistantOnlyView: assignedStudentIds !== null && !showAllStudents,
    assignedStudentCount: assignedStudentIds !== null ? assignedStudentIds.length : null,
    student_search: student_search || '',
    show_all_students: showAllStudents,
    marked_filter: marked_filter || 'all',
  });
});

app.get('/hw/submissions/:id', requirePermission('homework_online'), async (req, res) => {
  const submission = await HomeworkSubmission.findByPk(req.params.id, {
    include: [{ model: Student, include: [Center, Subject] }],
  });
  if (!submission) return res.status(404).json({ success: false, message: 'غير موجود' });

  res.json({
    success: true,
    submission: {
      id: submission.id,
      assignmentId: submission.HomeworkAssignmentId,
      studentName: submission.Student.name,
      subjectName: submission.Student.Subject ? submission.Student.Subject.name : '-',
      centerName: submission.Student.Center ? submission.Student.Center.name : '-',
      studentCode: submission.Student.student_code,
      paths: JSON.parse(submission.images || '[]'),
      comment: submission.student_comment,
      status: submission.status,
      createdAt: submission.createdAt,
    },
  });
});

// --- تصحيح الواجب ---

app.post('/hw/submissions/:id/grade', requirePermission('homework_online'), async (req, res) => {
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
    let assignments = await HomeworkAssignment.findAll({
      where: { SubjectId: student.SubjectId },
      include: [
        { model: Session, required: false, attributes: ['id', 'CenterId'] },
        { model: Session, as: 'LinkedSessions', required: false, attributes: ['id', 'CenterId'] },
      ],
      order: [['order_number', 'ASC']],
    });

    const studentAttendances = await Attendance.findAll({
      where: { StudentId: student.id },
      attributes: ['SessionId'],
    });
    const attendedSessionIds = new Set(studentAttendances.map(a => a.SessionId));

    const visibleAssignments = [];
    for (const a of assignments) {
      const sessionCenterIds = new Set();
      if (a.Session && a.Session.CenterId) sessionCenterIds.add(a.Session.CenterId);
      if (a.LinkedSessions) a.LinkedSessions.forEach(s => s.CenterId && sessionCenterIds.add(s.CenterId));
      if (!sessionCenterIds.size || !sessionCenterIds.has(student.CenterId)) continue;

      const assignmentSessionIds = [
        ...(a.SessionId ? [a.SessionId] : []),
        ...(a.LinkedSessions || []).map(s => s.id),
      ].filter(Boolean);
      if (assignmentSessionIds.length && !a.show_for_all) {
        const attended = assignmentSessionIds.some(id => attendedSessionIds.has(id));
        if (!attended) continue;
      }

      visibleAssignments.push(a);
    }

    const result = await Promise.all(visibleAssignments.map(async a => {
      const submission = await HomeworkSubmission.findOne({
        where: { HomeworkAssignmentId: a.id, StudentId: student.id },
      });

      // حالة في السنتر
      let centerStatus = null;
      const assignmentSessionIds = [
        ...(a.SessionId ? [a.SessionId] : []),
        ...(a.LinkedSessions || []).map(s => s.id),
      ].filter(Boolean);
      if (assignmentSessionIds.length) {
        const hw = await HomeworkCheck.findOne({ where: { StudentId: student.id, SessionId: assignmentSessionIds } });
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

    // بنستقبل المسارات بس (مش ملفات) - الصور/الـ PDF اتخزنت على Hostinger بالفعل
    const { imagePaths, pdfPaths, pdfPath, attachments, comment } = req.body;

    const normalizedImagePaths = Array.isArray(imagePaths)
      ? imagePaths.filter(Boolean)
      : (imagePaths ? [imagePaths] : []);
    const normalizedPdfPaths = Array.isArray(pdfPaths)
      ? pdfPaths.filter(Boolean)
      : (pdfPath ? [pdfPath] : []);
    const normalizedAttachmentPaths = Array.isArray(attachments)
      ? attachments.filter(Boolean)
      : (attachments ? [attachments] : []);

    const submissionPaths = [...normalizedImagePaths, ...normalizedPdfPaths, ...normalizedAttachmentPaths].filter(Boolean);

    if (submissionPaths.length === 0) {
      return res.json({ success: false, message: 'مفيش ملفات مرفوعة' });
    }

    const existing = await HomeworkSubmission.findOne({
      where: { HomeworkAssignmentId: req.params.id, StudentId: student.id },
    });

    if (existing) {
      const oldPaths = JSON.parse(existing.images || '[]');
      existing.images = JSON.stringify([...oldPaths, ...submissionPaths]);
      existing.student_comment = comment || existing.student_comment;
      existing.status = 'submitted';
      await existing.save();
    } else {
      await HomeworkSubmission.create({
        HomeworkAssignmentId: req.params.id,
        StudentId: student.id,
        images: JSON.stringify(submissionPaths),
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
      if (existing.custom_price === null || existing.custom_price === undefined) {
        existing.custom_price = booklet.sell_price;
      }
      existing.notes = notes || existing.notes;
      await existing.save();
    } else {
      await StudentBooklet.create({
        StudentId: student.id,
        BookletId: booklet_id,
        paid_amount: parseFloat(paid_amount),
        custom_price: booklet.sell_price,
        notes,
      });
    }

    if (!student.booklet_status) {
      student.booklet_status = true;
      await student.save();
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

app.post('/students/:studentId/booklet-edit-paid', requireAdmin, async (req, res) => {
  try {
    const { booklet_id, paid_amount, notes } = req.body;
    const student = await Student.findByPk(req.params.studentId);
    const booklet = await Booklet.findByPk(booklet_id);
    if (!student || !booklet) return res.status(404).send('❌');

    const newPaidAmount = parseFloat(paid_amount) || 0;
    const existing = await StudentBooklet.findOne({ where: { StudentId: student.id, BookletId: booklet_id } });
    
    if (existing) {
      const oldPaidAmount = existing.paid_amount;
      const difference = newPaidAmount - oldPaidAmount;
      
      existing.paid_amount = newPaidAmount;
      if (existing.custom_price === null || existing.custom_price === undefined) {
        existing.custom_price = booklet.sell_price;
      }
      existing.notes = notes ? `${existing.notes ? existing.notes + ' | ' : ''}تعديل: ${notes}` : existing.notes;
      await existing.save();

      // Create a transaction record for the change
      const transactionReason = notes 
        ? `تعديل مبلغ بوكليت (${booklet.name}): ${notes}`
        : `تعديل مبلغ بوكليت: ${booklet.name}`;
      
      await BalanceTransaction.create({
        StudentId: student.id,
        amount: difference,
        reason: transactionReason,
        UserId: req.session.userId,
      });
    } else {
      await StudentBooklet.create({
        StudentId: student.id,
        BookletId: booklet_id,
        paid_amount: newPaidAmount,
        custom_price: booklet.sell_price,
        notes: notes ? `تعديل: ${notes}` : null,
      });

      await BalanceTransaction.create({
        StudentId: student.id,
        amount: newPaidAmount,
        reason: notes ? `تعديل بوكليت (${booklet.name}): ${notes}` : `تعديل بوكليت: ${booklet.name}`,
        UserId: req.session.userId,
      });
    }

    if (!student.booklet_status) {
      student.booklet_status = true;
      await student.save();
    }

    res.redirect('/students/' + req.params.studentId);
  } catch (e) { console.error(e); res.status(500).send('❌ ' + e.message); }
});

app.post('/students/:studentId/booklet-deliver/:sbId', requireAdmin, async (req, res) => {
  const sb = await StudentBooklet.findByPk(req.params.sbId);
  if (sb) {
    sb.is_delivered = true;
    sb.delivered_at = new Date();
    await sb.save();

    const student = await Student.findByPk(sb.StudentId);
    if (student && !student.booklet_status) {
      student.booklet_status = true;
      await student.save();
    }
  }
  res.redirect('/students/' + req.params.studentId);
});

app.post('/attendance/scan/booklet-deliver', requireAdmin, async (req, res) => {
  try {
    const { studentId, studentBookletId } = req.body;
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'الطالب غير محدد' });
    }

    const student = await Student.findByPk(studentId);
    if (!student) {
      return res.status(404).json({ success: false, message: 'الطالب غير موجود' });
    }

    if (studentBookletId) {
      const sb = await StudentBooklet.findOne({ where: { id: studentBookletId, StudentId: studentId } });
      if (!sb) {
        return res.status(404).json({ success: false, message: 'البيانات غير موجودة' });
      }
      if (sb.is_delivered) {
        if (!student.booklet_status) {
          student.booklet_status = true;
          await student.save();
        }
        return res.json({ success: true, alreadyDelivered: true });
      }
      sb.is_delivered = true;
      sb.delivered_at = new Date();
      await sb.save();
    } else {
      await markDefaultBookletDelivered(student);
    }

    if (!student.booklet_status) {
      student.booklet_status = true;
      await student.save();
    }

    res.json({ success: true, alreadyDelivered: false });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'حصلت مشكلة في تحديث حالة التسليم' });
  }
});

// ===== تسجيل حضور مع دفع بوكليت =====

// تأكد إن route الـ /attendance/scan POST بيستقبل booklet_payments
// ضيف الكود ده بعد حفظ الـ Attendance:

async function processBookletPayments(studentId, bookletPayments, userId, sessionId = null) {
  if (!bookletPayments) return;
  const student = await Student.findByPk(studentId);
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

    if (student && !student.booklet_status) {
      student.booklet_status = true;
      await student.save();
    }

    await BalanceTransaction.create({
      StudentId: studentId,
      amount: parseFloat(payment.amount),
      SessionId: sessionId || null,
      reason: `دفع بوكليت: ${booklet.name}`,
      UserId: userId,
    });
  }
}

// ===== API البوابة: قائمة البوكليتس للطالب =====

app.get('/api/portal/booklets', verifyPortalToken('student'), async (req, res) => {
  try {
    const student = await Student.findByPk(req.portalStudentId);
    await syncStudentBookletStatus(student);
    const booklets = await Booklet.findAll({
      where: { SubjectId: student.SubjectId, is_active: true },
      order: [['order_index', 'ASC']],
    });

    const result = await Promise.all(booklets.map(async b => {
      const sb = await StudentBooklet.findOne({ where: { StudentId: student.id, BookletId: b.id } });
      const reservation = await BookletReservation.findOne({
        where: { StudentId: student.id, BookletId: b.id, status: { [Op.ne]: 'rejected' } },
      });
      const effectivePrice = getEffectiveBookletPrice(b, sb);
      return {
        id: b.id, name: b.name, sellPrice: effectivePrice,
        paidAmount: sb ? sb.paid_amount : 0,
        remaining: effectivePrice - (sb ? sb.paid_amount : 0),
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
      sessionPayment: getActualSessionPayment(a),
      attendedAt: a.attended_at,
    }));

    // مدفوعات البوكليتس المرتبطة بهذه الحصة فقط
    const bookletTransactions = await BalanceTransaction.findAll({
      where: {
        SessionId: session.id,
        reason: { [Op.like]: 'دفع بوكليت:%' },
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
      bucket.sessionTotal += getActualSessionPayment(a);
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

// ===== نظام أسيستانت المتابعة (مستقل تماماً) =====

// Middleware خاص بأسيستانت المتابعة
function requireFollowUp(req, res, next) {
  if (req.session.userRole === 'admin' || req.session.userRole === 'follow_up' || 
      (req.session.userPermissions && req.session.userPermissions.includes('follow_up'))) {
    return next();
  }
  res.status(403).send('⛔ غير مسموح');
}

// ===== الصفحة الرئيسية لأسيستانت المتابعة =====
app.get('/follow-up-dashboard', requireFollowUp, async (req, res) => {
  try {
    const { filter_video_type, filter_video_max, filter_hw_status, filter_exam_max, session_id, show_all, center_id, subject_id } = req.query;

    // load centers & subjects for filters
    const centersList = await Center.findAll({ order: [['name', 'ASC']] });
    const subjectsList = await Subject.findAll({ order: [['name', 'ASC']] });

    // Decide which students to show: either all (with optional center/subject filters) or only assigned
    let students = [];
    if (show_all) {
      const where = {};
      if (center_id) where.CenterId = center_id;
      if (subject_id) where.SubjectId = subject_id;
      students = await Student.findAll({ where, include: [Center, Subject], order: [['name', 'ASC']] });
    } else {
      // جلب الطلاب المُسندين لهذا الأسيستانت
      const assignments = await FollowUpAssignment.findAll({
        where: req.session.userRole !== 'admin' ? { AssistantId: req.session.userId } : {},
        include: [{
          model: Student,
          include: [Center, Subject],
        }],
      });
      students = assignments.map(a => a.Student).filter(Boolean);
      // apply optional center/subject filters on assigned list
      if (center_id) students = students.filter(s => String(s.CenterId) === String(center_id));
      if (subject_id) students = students.filter(s => String(s.SubjectId) === String(subject_id));
    }

    const sessions = await Session.findAll({
      order: [['lesson_number', 'DESC']],
      include: [Center, Subject],
    });

    // لو مفيش session مختار، اختار أحدث حصة
    const selectedSession = session_id 
      ? sessions.find(s => String(s.id) === String(session_id))
      : sessions[0];

    // If there are no assigned students at all, render empty state immediately
    if (students.length === 0) {
      return res.render('follow-up-dashboard', {
        students: [], sessionRows: [], sessions, selectedSession: null,
        filters: { filter_video_type, filter_video_max, filter_hw_status, filter_exam_max, session_id, show_all: show_all || '', center_id: center_id || '', subject_id: subject_id || '' },
        absentStudents: [],
        centers: centersList,
        subjects: subjectsList,
        hasFilters: false,
      });
    }

    // If there is no selected session but the assistant has assigned students,
    // render the page with students list so the assistant can see how many they follow up.
    if (!selectedSession) {
      return res.render('follow-up-dashboard', {
        students, sessionRows: [], sessions, selectedSession: null,
        filters: { filter_video_type, filter_video_max, filter_hw_status, filter_exam_max, session_id, show_all: show_all || '', center_id: center_id || '', subject_id: subject_id || '' },
        absentStudents: [],
        centers: centersList,
        subjects: subjectsList,
        hasFilters: false,
      });
    }

    // بيانات كل طالب في الحصة المختارة
    const watchRecords = await WatchProgress.findAll({
      where: { StudentId: students.map(s => s.id) },
      include: [VideoPart],
    });
    const watchMap = {};
    watchRecords.forEach(w => { watchMap[`${w.StudentId}_${w.VideoPartId}`] = w.watched_seconds; });

    const video = await Video.findOne({
      where: { SessionId: selectedSession.id },
      include: [{ model: VideoPart, order: [['order_index', 'ASC']] }],
    });

    const sessionRows = [];
    const absentStudents = [];

    for (const student of students) {
      const attendance = await Attendance.findOne({
        where: { StudentId: student.id, SessionId: selectedSession.id },
        include: [User],
      });
      const hw = await HomeworkCheck.findOne({
        where: { StudentId: student.id, SessionId: selectedSession.id },
      });
      const examResult = await ExamResult.findOne({
        where: { StudentId: student.id },
        include: [{ model: Exam, where: { SessionId: selectedSession.id }, required: true }],
      }).catch(() => null);

      const sessionComment = await SessionComment.findOne({
        where: { StudentId: student.id, SessionId: selectedSession.id },
      });

      // مدد المشاهدة حسب نوع الفيديو
      let videoWatch = { explanation: 0, questions: 0, homework_solution: 0, explanationTotal: 0, questionsTotal: 0, hwTotal: 0 };
      if (video && video.VideoParts) {
        video.VideoParts.forEach(part => {
          const watched = watchMap[`${student.id}_${part.id}`] || 0;
          videoWatch[part.category] = (videoWatch[part.category] || 0) + watched;
          videoWatch[`${part.category}Total`] = (videoWatch[`${part.category}Total`] || 0) + part.duration_seconds;
        });
      }

      const row = {
        student,
        attended: !!attendance,
        attendedWhere: attendance ? (await Session.findByPk(attendance.SessionId, { include: [Center] }))?.Center?.name : null,
        attendanceTime: attendance ? attendance.attended_at : null,
        attendedBy: attendance ? attendance.User?.name : null,
        hwStatus: hw ? hw.status : null,
        examScore: examResult ? examResult.score : null,
        examMax: examResult ? examResult.Exam?.max_score : null,
        videoWatch,
        sessionComment: sessionComment ? sessionComment.comment : null,
      };

      if (!attendance) absentStudents.push(row);
      sessionRows.push(row);
    }

    // تطبيق الفلاتر
    let filteredRows = [...sessionRows];

    if (filter_video_type && filter_video_max) {
      const maxMin = parseFloat(filter_video_max);
      filteredRows = filteredRows.filter(r => {
        const watchedMin = r.videoWatch[filter_video_type] / 60;
        return watchedMin <= maxMin;
      });
    }

    if (filter_hw_status) {
      filteredRows = filteredRows.filter(r => r.hwStatus === filter_hw_status || (!r.hwStatus && filter_hw_status === 'not_checked'));
    }

    if (filter_exam_max) {
      filteredRows = filteredRows.filter(r => r.examScore !== null && r.examScore <= parseFloat(filter_exam_max));
    }

    res.render('follow-up-dashboard', {
      students, sessionRows: filteredRows, sessions, selectedSession,
      filters: { filter_video_type, filter_video_max, filter_hw_status, filter_exam_max, session_id, show_all: show_all || '', center_id: center_id || '', subject_id: subject_id || '' },
      absentStudents: absentStudents,
      hasFilters: !!(filter_video_type || filter_hw_status || filter_exam_max),
      centers: centersList,
      subjects: subjectsList,
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// Temporary debug endpoint: list follow-up assignments for current user
app.get('/debug/followups', requireLogin, async (req, res) => {
  try {
    const assignments = await FollowUpAssignment.findAll({
      where: { AssistantId: req.session.userId },
      include: [{ model: Student, include: [Center, Subject] }],
    });
    res.json({ count: assignments.length, assignments });
  } catch (e) {
    console.error('Debug followups failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== ملف طالب من منظور المتابعة =====
app.get('/follow-up-dashboard/student/:id', requireFollowUp, async (req, res) => {
  try {
    const student = await Student.findByPk(req.params.id, { include: [Center, Subject] });
    if (!student) return res.status(404).send('❌');

    const followUpAssistant = await getFollowUpAssistantForStudent(student.id);
    const assignment = await FollowUpAssignment.findOne({
      where: { StudentId: student.id },
      include: [{ model: User, as: 'Assistant', attributes: ['id', 'name', 'username', 'phone'] }],
    });

    const ownSessions = await Session.findAll({
      where: { SubjectId: student.SubjectId },
      include: [Center],
      order: [['lesson_number', 'ASC']],
    });

    const attendances = await Attendance.findAll({
      where: { StudentId: student.id },
      include: [{ model: Session, include: [Center] }, User],
    });
    const attMap = {};
    attendances.forEach(a => { if (a.Session.SubjectId === student.SubjectId) attMap[a.Session.lesson_number] = a; });

    const hwChecks = await HomeworkCheck.findAll({
      where: { StudentId: student.id },
      include: [{ model: Session }],
    });
    const hwMap = {};
    hwChecks.forEach(h => { if (h.Session.SubjectId === student.SubjectId) hwMap[h.Session.lesson_number] = h; });

    const examResults = await ExamResult.findAll({
      where: { StudentId: student.id },
      include: [{ model: Exam, include: [Session] }],
    });
    const examMap = {};
    examResults.forEach(r => { if (r.Exam?.Session) examMap[r.Exam.Session.lesson_number] = r; });

    const sessionComments = await SessionComment.findAll({
      where: { StudentId: student.id },
      include: [Session, User],
    });
    const commentMap = {};
    sessionComments.forEach(c => { commentMap[c.Session.lesson_number] = c; });

    const watchRecords = await WatchProgress.findAll({ where: { StudentId: student.id } });
    const watchMap = {};
    watchRecords.forEach(w => { watchMap[w.VideoPartId] = w.watched_seconds; });

    const videos = await Video.findAll({
      where: { SubjectId: student.SubjectId },
      include: [{ model: VideoPart }, Session],
    });
    const videoByLesson = {};
    videos.forEach(v => { if (v.Session) videoByLesson[v.Session.lesson_number] = v; });

    const lessonData = ownSessions.map(s => {
      const att = attMap[s.lesson_number];
      const hw = hwMap[s.lesson_number];
      const exam = examMap[s.lesson_number];
      const comment = commentMap[s.lesson_number];
      const video = videoByLesson[s.lesson_number];

      let videoWatch = {};
      if (video && video.VideoParts) {
        video.VideoParts.forEach(p => {
          const cat = p.category;
          videoWatch[cat] = (videoWatch[cat] || 0) + (watchMap[p.id] || 0);
          videoWatch[`${cat}Total`] = (videoWatch[`${cat}Total`] || 0) + p.duration_seconds;
        });
      }

      return {
        session: s,
        attended: !!att,
        attendedWhere: att ? att.Session?.Center?.name : null,
        attendanceTime: att ? att.attended_at : null,
        attendedBy: att ? att.User?.name : null,
        hwStatus: hw ? hw.status : null,
        examScore: exam ? exam.score : null,
        examMax: exam ? exam.Exam?.max_score : null,
        videoWatch,
        comment: comment ? comment.comment : null,
        commentUser: comment ? comment.User?.name : null,
      };
    });

    res.render('follow-up-student', { student, assignment, followUpAssistant, lessonData });
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// ===== إضافة/تعديل كومنت الحصة =====
app.post('/follow-up-dashboard/comment', requireFollowUp, async (req, res) => {
  try {
    const { student_id, session_id, comment, redirect_to } = req.body;
    const [sc] = await SessionComment.findOrCreate({
      where: { StudentId: student_id, SessionId: session_id },
      defaults: { UserId: req.session.userId, comment },
    });
    if (sc.comment !== comment) {
      sc.comment = comment;
      sc.UserId = req.session.userId;
      await sc.save();
    }
    res.redirect(redirect_to || '/follow-up-dashboard');
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// ===== إدارة التوزيع (أدمن بس) =====
app.get('/admin/follow-up-management', requireAdmin, async (req, res) => {
  try {
    const { subject_id, center_id } = req.query;
    const followUpUsers = await User.findAll({
      where: {
        [Op.or]: [
          { role: 'follow_up' },
          // أو اللي عندهم صلاحية follow_up
        ]
      },
    });

    // لو مفيش follow_up role، جيب من الصلاحيات
    const allUsers = await User.findAll({ order: [['name', 'ASC']] });
    const followUpEligible = allUsers.filter(u =>
      u.role === 'follow_up' ||
      (u.permissions && JSON.parse(u.permissions || '[]').includes('follow_up'))
    );

    const assignments = await FollowUpAssignment.findAll({
      include: [
        { model: User, as: 'Assistant' },
        { model: Student, include: [Subject, Center] },
      ],
      order: [['AssistantId', 'ASC']],
    });

    const unassignedStudents = await Student.findAll({
      where: {
        id: {
          [Op.notIn]: assignments.map(a => a.StudentId).length > 0
            ? assignments.map(a => a.StudentId)
            : [0],
        },
      },
      include: [Subject, Center],
      order: [['name', 'ASC']],
    });

    // إحصائيات كل أسيستانت
    const assistantStats = {};
    followUpEligible.forEach(u => {
      assistantStats[u.id] = {
        user: u,
        count: assignments.filter(a => a.AssistantId === u.id).length,
        students: assignments.filter(a => a.AssistantId === u.id).map(a => a.Student).filter(Boolean),
      };
    });

    const settings = await getFollowUpSettings();
    const [subjects, centers] = await Promise.all([
      Subject.findAll({ order: [['name', 'ASC']] }),
      Center.findAll({ order: [['name', 'ASC']] }),
    ]);

    const allStudentsFilter = {};
    if (subject_id) allStudentsFilter.SubjectId = subject_id;
    if (center_id) allStudentsFilter.CenterId = center_id;

    const allStudentsForBulk = await Student.findAll({
      where: allStudentsFilter,
      include: [Subject, Center],
      order: [['name', 'ASC']],
    });

    res.render('follow-up-management', {
      followUpEligible, assignments, unassignedStudents, assistantStats, allUsers, settings,
      allStudentsForBulk, subjects, centers, selectedSubjectId: subject_id || '', selectedCenterId: center_id || '',
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// إعدادات الحد الأقصى لكل أسيستانت
const followUpSettingsCache = {};
async function getFollowUpSettings() {
  // نخزنهم في جدول settings لو موجود، أو نرجع defaults
  return followUpSettingsCache;
}

app.post('/admin/follow-up-management/settings', requireAdmin, async (req, res) => {
  const settings = req.body;
  Object.assign(followUpSettingsCache, settings);
  res.redirect('/admin/follow-up-management');
});

// توزيع تلقائي
app.post('/admin/follow-up-management/auto-assign', requireAdmin, async (req, res) => {
  try {
    const followUpEligible = await User.findAll({
      where: {
        [Op.or]: [
          { role: 'follow_up' },
        ],
      },
    });

    const allUsers = await User.findAll();
    const eligible = allUsers.filter(u =>
      u.role === 'follow_up' ||
      (u.permissions && JSON.parse(u.permissions || '[]').includes('follow_up'))
    );

    if (eligible.length === 0) return res.redirect('/admin/follow-up-management');

    const unassigned = await Student.findAll({
      where: {
        id: {
          [Op.notIn]: (await FollowUpAssignment.findAll()).map(a => a.StudentId).length > 0
            ? (await FollowUpAssignment.findAll()).map(a => a.StudentId)
            : [0],
        },
      },
    });

    // توزيع round-robin
    for (let i = 0; i < unassigned.length; i++) {
      const assistant = eligible[i % eligible.length];
      const maxStudents = followUpSettingsCache[`max_${assistant.id}`] || 50;
      const currentCount = await FollowUpAssignment.count({ where: { AssistantId: assistant.id } });
      if (currentCount < maxStudents) {
        await FollowUpAssignment.create({
          AssistantId: assistant.id,
          StudentId: unassigned[i].id,
        });
      }
    }

    res.redirect('/admin/follow-up-management');
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// تعيين يدوي
app.post('/admin/follow-up-management/assign', requireAdmin, async (req, res) => {
  try {
    const { student_id, assistant_id } = req.body;
    await FollowUpAssignment.upsert({
      StudentId: student_id,
      AssistantId: assistant_id,
      assignedAt: new Date(),
    });
    res.redirect('/admin/follow-up-management');
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// إلغاء تعيين
app.post('/admin/follow-up-management/unassign/:studentId', requireAdmin, async (req, res) => {
  await FollowUpAssignment.destroy({ where: { StudentId: req.params.studentId } });
  res.redirect('/admin/follow-up-management');
});

app.post('/students/:id/delete', requireAdmin, async (req, res) => {
  try {
    const studentId = req.params.id;
    // حذف كل البيانات المرتبطة بالطالب
    await Attendance.destroy({ where: { StudentId: studentId } });
    await HomeworkCheck.destroy({ where: { StudentId: studentId } });
    await ExamResult.destroy({ where: { StudentId: studentId } });
    await BalanceTransaction.destroy({ where: { StudentId: studentId } });
    await WatchProgress.destroy({ where: { StudentId: studentId } });
    await VideoAccessGrant.destroy({ where: { StudentId: studentId } });
    await FollowUpAssignment.destroy({ where: { StudentId: studentId } });
    await SessionComment.destroy({ where: { StudentId: studentId } });
    await StudentBooklet.destroy({ where: { StudentId: studentId } });
    await BookletReservation.destroy({ where: { StudentId: studentId } });
    await Warning.destroy({ where: { StudentId: studentId } });
    await Student.destroy({ where: { id: studentId } });
    res.redirect('/students');
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

app.post('/students/:studentId/booklet-custom-price', requireAdmin, async (req, res) => {
  try {
    const { booklet_id, custom_price } = req.body;
    let normalizedCustomPrice = null;

    if (custom_price !== undefined && custom_price !== null && custom_price !== '') {
      normalizedCustomPrice = parseFloat(custom_price);
      if (Number.isNaN(normalizedCustomPrice)) {
        normalizedCustomPrice = null;
      }
    }

    const [studentBooklet] = await StudentBooklet.findOrCreate({
      where: { StudentId: req.params.studentId, BookletId: booklet_id },
      defaults: { paid_amount: 0, custom_price: normalizedCustomPrice },
    });

    studentBooklet.custom_price = normalizedCustomPrice;
    await studentBooklet.save();

    const student = await Student.findByPk(req.params.studentId);
    if (student && !student.booklet_status) {
      student.booklet_status = true;
      await student.save();
    }

    res.redirect('/students/' + req.params.studentId);
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// (moved earlier to avoid matching by /students/:id)

// رفع وتحليل الملف
function normalizeBulkPhone(value) {
  const str = value === undefined || value === null ? '' : String(value).trim();
  if (!str) return '';
  return str.startsWith('0') ? str : `0${str}`;
}

function normalizeBulkRow(raw) {
  const getString = value => (value === undefined || value === null ? '' : String(value).trim());
  return {
    name: getString(raw.name),
    phone: normalizeBulkPhone(raw.phone),
    parent_phone: normalizeBulkPhone(raw.parent_phone),
    subject_name: getString(raw.subject_name),
    center_name: getString(raw.center_name),
    price_per_session: getString(raw.price_per_session),
    initial_balance: getString(raw.initial_balance),
    booklet_name: getString(raw.booklet_name),
    booklet_paid: getString(raw.booklet_paid),
  };
}

function bulkRowKey(row) {
  return [
    row.name.toLowerCase(),
    row.phone.toLowerCase(),
    row.parent_phone.toLowerCase(),
    row.subject_name.toLowerCase(),
    row.center_name.toLowerCase(),
    row.price_per_session.toLowerCase(),
    row.initial_balance.toLowerCase(),
    row.booklet_name.toLowerCase(),
    row.booklet_paid.toLowerCase(),
  ].join('||');
}

async function createStudentFromBulkRow(row, userId) {
  const subject = await Subject.findOne({ where: { name: row.subject_name } });
  const center = await Center.findOne({ where: { name: row.center_name } });
  if (!subject) throw new Error(`المادة "${row.subject_name}" غير موجودة`);
  if (!center) throw new Error(`السنتر "${row.center_name}" غير موجود`);

  const student = await Student.create({
    name: row.name,
    phone: row.phone,
    parent_phone: row.parent_phone || null,
    price_per_session: parseFloat(row.price_per_session) || 0,
    balance: parseFloat(row.initial_balance) || 0,
    SubjectId: subject.id,
    CenterId: center.id,
    UserId: userId,
  });

  if (parseFloat(row.initial_balance) > 0) {
    await BalanceTransaction.create({
      StudentId: student.id,
      amount: parseFloat(row.initial_balance),
      reason: 'رصيد أولي (bulk upload)',
      UserId: userId,
    });
  }

  if (row.booklet_name && parseFloat(row.booklet_paid) > 0) {
    const booklet = await Booklet.findOne({ where: { name: row.booklet_name } });
    if (booklet) {
      await StudentBooklet.create({
        StudentId: student.id,
        BookletId: booklet.id,
        paid_amount: parseFloat(row.booklet_paid),
        custom_price: booklet.sell_price,
      });
      student.booklet_status = true;
      await student.save();
      await BalanceTransaction.create({
        StudentId: student.id,
        amount: parseFloat(row.booklet_paid),
        reason: `دفع بوكليت: ${booklet.name} (bulk upload)`,
        UserId: userId,
      });
    }
  }

  return student;
}

app.post('/students/bulk-upload', requireAdmin, bulkUpload.single('excel_file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('يرجى اختيار ملف Excel');
    }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const results = { success: [], errors: [], duplicateRows: [] };
    const parsedRows = rows.map((row, i) => ({
      rowNumber: i + 2,
      ...normalizeBulkRow(row),
    }));

    const validRows = [];
    for (const row of parsedRows) {
      if (!row.name || !row.phone || !row.subject_name || !row.center_name) {
        results.errors.push(`صف ${row.rowNumber}: بيانات ناقصة`);
      } else {
        validRows.push(row);
      }
    }

    const groups = new Map();
    validRows.forEach(row => {
      const key = bulkRowKey(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });

    const duplicateRowNumbers = new Set();
    for (const group of groups.values()) {
      if (group.length > 1) {
        group.slice(1).forEach(row => duplicateRowNumbers.add(row.rowNumber));
      }
    }

    for (const row of validRows) {
      if (duplicateRowNumbers.has(row.rowNumber)) {
        results.duplicateRows.push(row);
        continue;
      }

      try {
        const student = await createStudentFromBulkRow(row, req.session.userId);
        results.success.push({
          text: `${student.name} — ${row.subject_name} — ${row.center_name}`,
          rowNumber: row.rowNumber,
        });
      } catch (rowErr) {
        results.errors.push(`صف ${row.rowNumber}: ${rowErr.message}`);
      }
    }

    req.session.bulkUploadDuplicateRows = results.duplicateRows;
    res.render('bulk-upload-result', { results });
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

app.post('/students/bulk-upload/force-add', requireAdmin, async (req, res) => {
  try {
    const selected = Array.isArray(req.body.selected) ? req.body.selected : req.body.selected ? [req.body.selected] : [];
    const duplicateRows = req.session.bulkUploadDuplicateRows || [];
    const results = { success: [], errors: [], duplicateRows: [] };

    if (!selected.length) {
      results.errors.push('لم يتم اختيار أي صفوف للإضافة الإضافية.');
      results.duplicateRows = duplicateRows;
      return res.render('bulk-upload-result', { results });
    }

    const selectedIndexes = selected.map(value => Number(value)).filter(idx => !Number.isNaN(idx));
    for (const rowIndex of selectedIndexes) {
      const row = duplicateRows[rowIndex];
      if (!row) continue;
      try {
        const student = await createStudentFromBulkRow(row, req.session.userId);
        results.success.push({
          text: `${student.name} — ${row.subject_name} — ${row.center_name}`,
          rowNumber: row.rowNumber,
        });
      } catch (rowErr) {
        results.errors.push(`صف ${row.rowNumber}: ${rowErr.message}`);
      }
    }

    const remainingDuplicates = duplicateRows.filter((_, index) => !selectedIndexes.includes(index));
    req.session.bulkUploadDuplicateRows = remainingDuplicates.length ? remainingDuplicates : null;
    results.duplicateRows = remainingDuplicates;

    res.render('bulk-upload-result', { results });
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

app.post('/admin/follow-up-management/bulk-assign', requireAdmin, async (req, res) => {
  try {
    const { student_ids, assistant_id, action } = req.body;
    if (!student_ids) return res.redirect('/admin/follow-up-management');

    const ids = Array.isArray(student_ids) ? student_ids : [student_ids];

    if (action === 'assign' && assistant_id) {
      for (const sid of ids) {
        await FollowUpAssignment.upsert({
          StudentId: parseInt(sid),
          AssistantId: parseInt(assistant_id),
          assignedAt: new Date(),
        });
      }
    } else if (action === 'unassign') {
      await FollowUpAssignment.destroy({
        where: { StudentId: ids.map(id => parseInt(id)) },
      });
    }

    res.redirect('/admin/follow-up-management');
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ ' + e.message);
  }
});

// API: save/get student profile photo
app.post('/api/portal/student/profile-photo', verifyPortalToken('student'), async (req, res) => {
  try {
    const { photo_url } = req.body;
    if (!photo_url) return res.json({ success: false, message: 'No URL provided' });
    await Student.update({ profile_photo_url: photo_url }, { where: { id: req.portalStudentId } });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false });
  }
});

// User Profile Page
app.get('/user/profile', requireLogin, async (req, res) => {
  try {
    const user = await User.findByPk(req.session.userId);
    if (!user) return res.status(404).send('User not found');
    
    res.render('user-profile', { 
      user,
      profilePhotoUrl: user.profile_photo_url || null
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading profile');
  }
});

// User Profile Photo Upload
app.post('/user/profile-photo', requireLogin, profilePhotoUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const file = req.file;
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    const maxFileSize = 5 * 1024 * 1024; // 5MB
    
    if (!allowedMimes.includes(file.mimetype)) {
      return res.status(400).json({ success: false, message: 'Invalid file type. Only JPEG, PNG, and WebP are allowed.' });
    }

    if (file.size > maxFileSize) {
      return res.status(400).json({ success: false, message: 'File size exceeds 5MB limit' });
    }

    // Upload to Cloudinary
    const stream = cloudinary.uploader.upload_stream(
      { 
        folder: 'studyisfunny/user-profiles',
        resource_type: 'auto',
        quality: 'auto:best'
      },
      async (error, result) => {
        if (error) {
          console.error('Cloudinary upload error:', error);
          return res.status(500).json({ success: false, message: 'Upload failed' });
        }

        try {
          // Save photo URL to user
          await User.update(
            { profile_photo_url: result.secure_url },
            { where: { id: req.session.userId } }
          );

          res.json({ 
            success: true, 
            photoUrl: result.secure_url,
            message: 'تم تحديث صورة الملف الشخصي بنجاح'
          });
        } catch (e) {
          console.error(e);
          res.status(500).json({ success: false, message: 'Database error' });
        }
      }
    );

    const bufferStream = require('stream').Readable.from(file.data);
    bufferStream.pipe(stream);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

async function startServer() {
  // Attempt initial DB connection; if it fails, still start the HTTP server
  try {
    await connectWithRetry(5, 5000);
    dbReady = true;
    // IMPORTANT: منع sync المؤقتًا لتجنب Duplicate keys أثناء تشغيل السيرفر
    // await sequelize.sync();
    await RechargeCode.sync();
    await ensureUserPhoneColumn();
    await ensureSessionWeekNumberColumn();
    await ensureStudentBookletCustomPriceColumn();
    await ensureBalanceTransactionSessionColumn();
    await ensureHomeworkAssignmentShowForAllColumn();
    await ensureUserProfilePhotoColumn();
    await ensureBookletReservationSchema(sequelize);
    console.log('RechargeCode table is ready');
    console.log('✅ تم تجهيز اتصال قاعدة البيانات بنجاح (تم تعطيل sequelize.sync مؤقتًا)');
  } catch (error) {
    console.error('❌ فشل الاتصال بقاعدة البيانات أثناء التشغيل الابتدائي:', error.message);
    console.error('السيرفر سيبدأ بدون اتصال قاعدة البيانات. سأحاول إعادة الاتصال في الخلفية.');
  }

  // start HTTP/HTTPS server regardless of DB readiness so pages can load
  if (process.env.NODE_ENV === 'production') {
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

  // If DB wasn't ready, keep retrying in the background and apply schema fixes when it comes up
  if (!dbReady) {
    (async function backgroundReconnect() {
      while (!dbReady) {
        try {
          console.log('🔁 محاولة إعادة الاتصال بقاعدة البيانات في الخلفية...');
          await connectWithRetry(5, 10000);
          dbReady = true;
          await RechargeCode.sync();
          await ensureUserPhoneColumn();
          await ensureSessionWeekNumberColumn();
          await ensureStudentBookletCustomPriceColumn();
          await ensureUserProfilePhotoColumn();
          await ensureBookletReservationSchema(sequelize);
          console.log('✅ إعادة الاتصال بقاعدة البيانات ناجحة — المزامنة مكتملة');
          break;
        } catch (e) {
          console.error('خلفية: فشل إعادة الاتصال بقاعدة البيانات:', e.message);
          await new Promise(r => setTimeout(r, 10000));
        }
      }
    })();
  }
}

if (process.env.VERCEL) {
  module.exports = app;
} else {
  startServer();
}
