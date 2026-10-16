// تفاصيل الطالب اللي بتظهر وقت مسح الحضور (نفس /attendance/scan/lookup) بس لكل الطلاب مرة واحدة،
// عشان الموبايل يعرضها كاملة من غير نت (أو لما ياخد البيانات من جهاز تاني في الشبكة):
//   تاريخ حضور كل طالب بالحصص + امتحاناته + البوكليتات (المدفوع/الباقي/الاستلام) + أسيستانت المتابعة.
// قراءة بس — مفيش أي كتابة. كل الأعمدة جديدة في آخر الـ JSON فالإصدارات القديمة من التطبيق بتتجاهلها.

function num(value) {
  const n = parseFloat(value);
  return Number.isNaN(n) ? 0 : n;
}

// نفس getEffectiveBookletPrice في server.js
function effectivePrice(booklet, studentBooklet) {
  if (studentBooklet && studentBooklet.custom_price !== null && studentBooklet.custom_price !== undefined) {
    const custom = parseFloat(studentBooklet.custom_price);
    if (!Number.isNaN(custom) && custom >= 0) return custom;
  }
  const base = parseFloat(booklet.sell_price);
  return !Number.isNaN(base) && base >= 0 ? base : 0;
}

async function buildMobileDetails(sequelize) {
  const { Attendance, Session, Exam, ExamResult, Booklet, StudentBooklet, BookletReservation, FollowUpAssignment, User } = sequelize.models;
  const t = model => model.getTableName();
  const [
    [history],
    [groups],
    exams,
    booklets,
    studentBooklets,
    reservations,
    followUps,
  ] = await Promise.all([
    // [طالب, رقم الحصة, السنتر اللي حضر فيه] لنفس مادة الطالب
    sequelize.query(
      `SELECT a.StudentId, s.lesson_number, s.CenterId FROM ${t(Attendance)} a
       JOIN ${t(Session)} s ON s.id = a.SessionId
       JOIN students st ON st.id = a.StudentId AND st.SubjectId = s.SubjectId`,
    ),
    // أرقام الحصص بتاعة كل مجموعة (سنتر + مادة)
    sequelize.query(`SELECT DISTINCT CenterId, SubjectId, lesson_number FROM ${t(Session)}`),
    ExamResult.findAll({
      attributes: ['StudentId', 'score'],
      include: [{ model: Exam, where: { SessionId: null }, attributes: ['name', 'max_score', 'exam_date'], required: true }],
      order: [[Exam, 'exam_date', 'DESC']],
      raw: true,
    }),
    Booklet.findAll({ where: { is_active: true }, attributes: ['id', 'name', 'SubjectId', 'sell_price', 'order_index'], order: [['order_index', 'ASC']], raw: true }),
    sequelize.query(`SELECT StudentId, BookletId, paid_amount, custom_price, is_delivered FROM ${t(StudentBooklet)} ORDER BY id ASC`, { type: sequelize.QueryTypes.SELECT }),
    sequelize.query(`SELECT StudentId, BookletId, status FROM ${t(BookletReservation)} WHERE status <> 'rejected' ORDER BY id ASC`, { type: sequelize.QueryTypes.SELECT }),
    FollowUpAssignment.findAll({ attributes: ['StudentId'], include: [{ model: User, as: 'Assistant', attributes: ['name'] }], raw: true }),
  ]);

  const bookletById = new Map(booklets.map(b => [b.id, b]));
  const seenSb = new Set();
  const sb = [];
  for (const row of studentBooklets) {
    const key = `${row.StudentId}:${row.BookletId}`;
    const booklet = bookletById.get(row.BookletId);
    if (!booklet || seenSb.has(key)) continue; // نفس اللي بيعمله الموقع: أول سجل بس
    seenSb.add(key);
    // [طالب, بوكليت, السعر الفعلي, المدفوع, اتسلم]
    sb.push([row.StudentId, row.BookletId, effectivePrice(booklet, row), num(row.paid_amount), row.is_delivered ? 1 : 0]);
  }
  const seenRes = new Set();
  const res = [];
  for (const row of reservations) {
    const key = `${row.StudentId}:${row.BookletId}`;
    if (seenRes.has(key)) continue;
    seenRes.add(key);
    res.push([row.StudentId, row.BookletId, row.status]);
  }

  return {
    v: 1,
    history: history.map(r => [r.StudentId, r.lesson_number, r.CenterId]),
    groups: groups.map(r => [r.CenterId, r.SubjectId, r.lesson_number]),
    exams: exams.map(r => [r.StudentId, r['Exam.name'], num(r.score), num(r['Exam.max_score']), r['Exam.exam_date']]),
    booklets: booklets.map(b => [b.id, b.SubjectId, b.name, num(b.sell_price)]),
    studentBooklets: sb,
    reservations: res,
    followUp: followUps.filter(r => r['Assistant.name']).map(r => [r.StudentId, r['Assistant.name']]),
  };
}

module.exports = { buildMobileDetails };
