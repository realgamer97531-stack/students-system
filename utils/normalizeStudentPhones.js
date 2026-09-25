// بينضف أرقام الطلاب وأولياء الأمور المتسجلة قبل كده بمسافات.
// بيعدل بس الصفوف اللي فيها مسافات فعلاً، ومن خلال الـ ORM (نفس setter الموديل).
// آمن إنه يتشغل كل مرة السيرفر يقوم: لو مفيش حاجة محتاجة تنضيف مش بيعمل أي تعديل.
const Student = require('../models/Student');

async function normalizeStudentPhones() {
  const rows = await Student.findAll({
    attributes: ['id', 'phone', 'parent_phone'],
    raw: true,
  });

  let fixed = 0;
  for (const row of rows) {
    const phone = Student.stripPhoneSpaces(row.phone);
    const parentPhone = Student.stripPhoneSpaces(row.parent_phone);
    const changes = {};
    if (phone !== row.phone) changes.phone = phone;
    if (parentPhone !== row.parent_phone) changes.parent_phone = parentPhone;
    if (Object.keys(changes).length === 0) continue;

    await Student.update(changes, { where: { id: row.id }, hooks: false });
    fixed += 1;
  }

  if (fixed > 0) {
    console.log(`📞 تم تنضيف المسافات من أرقام ${fixed} طالب`);
  }
  return fixed;
}

module.exports = normalizeStudentPhones;
