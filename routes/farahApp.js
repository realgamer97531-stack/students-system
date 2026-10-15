// تطبيق "Farah" (منبه الأسيستانت): دخول بيوزر وباسورد الموظف + حصص النهارده من الجدول.
// قراءة بس، مفيش أي كتابة في الداتابيز. التوكن مستقل عن جلسة الموقع (type: 'farah').
//   POST /api/farah/login   { username, password } -> { token, user }
//   GET  /api/farah/today   Authorization: Bearer <token> -> حصص النهارده (الجدول + الحصة لو اتعملت)

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const User = require('../models/User');
const ScheduleEntry = require('../models/ScheduleEntry');
const Session = require('../models/Session');
const Subject = require('../models/Subject');
const Center = require('../models/Center');

const TOKEN_DAYS = 180;

function ymdLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addMinutes(hhmm, minutes) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  const total = ((h || 0) * 60 + (m || 0) + (Number(minutes) || 0)) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function requireFarahToken(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'سجلي دخول الأول' });
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (decoded.type !== 'farah') throw new Error('Invalid token type');
    req.farahUserId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: 'انتهت صلاحية الدخول، سجلي دخول تاني' });
  }
}

function registerFarahAppRoutes(app) {
  app.post('/api/farah/login', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      const user = username ? await User.findOne({ where: { username: String(username).trim() } }) : null;
      const valid = user && await bcrypt.compare(String(password || ''), user.password);
      if (!valid) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return res.status(401).json({ success: false, message: 'اليوزرنيم أو الباسورد غلط' });
      }
      const token = jwt.sign({ userId: user.id, type: 'farah' }, process.env.JWT_SECRET, { expiresIn: `${TOKEN_DAYS}d` });
      res.json({ success: true, token, user: { id: user.id, name: user.name, role: user.role } });
    } catch (error) {
      console.error('Farah login error:', error);
      res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
    }
  });

  app.get('/api/farah/today', requireFarahToken, async (req, res) => {
    try {
      const user = await User.findByPk(req.farahUserId, { attributes: ['id', 'name', 'role'] });
      if (!user) return res.status(401).json({ success: false, message: 'الحساب مش موجود' });

      const now = new Date();
      const today = ymdLocal(now);
      const entries = await ScheduleEntry.findAll({
        where: {
          is_active: true,
          day_of_week: now.getDay(),
          [Op.or]: [{ end_date: null }, { end_date: { [Op.gte]: today } }],
        },
        order: [['start_time', 'ASC']],
      });

      const subjectIds = [...new Set(entries.map(e => e.SubjectId))];
      const centerIds = [...new Set(entries.map(e => e.CenterId))];
      const [subjects, centers, sessions] = await Promise.all([
        subjectIds.length ? Subject.findAll({ where: { id: subjectIds }, attributes: ['id', 'name'] }) : [],
        centerIds.length ? Center.findAll({ where: { id: centerIds }, attributes: ['id', 'name'] }) : [],
        Session.findAll({
          where: { session_date: today },
          attributes: ['id', 'lesson_number', 'week_number', 'serial_number', 'status', 'CenterId', 'SubjectId'],
        }),
      ]);
      const subjectName = new Map(subjects.map(s => [s.id, s.name]));
      const centerName = new Map(centers.map(c => [c.id, c.name]));

      const out = entries
        .filter(e => subjectName.has(e.SubjectId) && centerName.has(e.CenterId))
        .map(e => {
          const start = String(e.start_time || '').slice(0, 5);
          const session = sessions.find(s => s.CenterId === e.CenterId && s.SubjectId === e.SubjectId);
          return {
            id: e.id,
            subject: subjectName.get(e.SubjectId),
            center: centerName.get(e.CenterId),
            start_time: start,
            end_time: addMinutes(start, e.duration_minutes || 90),
            duration_minutes: e.duration_minutes || 90,
            notes: e.notes || null,
            session: session ? {
              id: session.id,
              lesson_number: session.lesson_number,
              week_number: session.week_number,
              serial_number: session.serial_number,
              status: session.status,
            } : null,
          };
        });

      res.json({ success: true, date: today, user: { id: user.id, name: user.name }, sessions: out });
    } catch (error) {
      console.error('Farah today error:', error);
      res.status(500).json({ success: false, message: 'حصلت مشكلة في السيرفر' });
    }
  });
}

module.exports = registerFarahAppRoutes;
