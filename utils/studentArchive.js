// أرشيف الطلاب المحذوفين: قبل ما نحذف أي طالب بناخد نسخة كاملة منه ومن كل البيانات اللي بتتحذف معاه،
// وبنحفظها في جدول deleted_student_archive مع اسم اللي حذف. وبكده نقدر نرجّع الطالب زي ما كان.
//
// الجدول بيتعمل بـ CREATE TABLE IF NOT EXISTS بس — مفيش أي تعديل على جداول موجودة.
const DeletedStudentArchive = require('../models/DeletedStudentArchive');

let ensurePromise = null;

function ensureDeletedStudentArchiveSchema() {
  if (!ensurePromise) {
    ensurePromise = DeletedStudentArchive.sync().catch((error) => {
      ensurePromise = null; // يسمح بإعادة المحاولة عند إعادة الاتصال
      throw error;
    });
  }
  return ensurePromise;
}

// التواريخ بتتحفظ بصيغة MySQL بتوقيت UTC (زي ما هي متخزنة) عشان ترجع بالظبط
function toArchiveRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString().replace('T', ' ').replace('Z', '') : value;
  }
  return out;
}

// بنقرا الصفوف بـ SELECT * (مش من الـ model) عشان ناخد كل الأعمدة اللي في الجدول فعلًا،
// حتى الأعمدة اللي بتتضاف من الـ associations زي CenterId و SubjectId
async function selectRows(sequelize, table, column, id, transaction) {
  const rows = await sequelize.query(
    `SELECT * FROM \`${table}\` WHERE \`${column}\` = ?`,
    { replacements: [id], type: sequelize.QueryTypes.SELECT, transaction }
  );
  return rows.map(toArchiveRow);
}

function tableNameOf(Model) {
  const name = Model.getTableName();
  return typeof name === 'string' ? name : name.tableName;
}

// models: { Student, related: { Attendance, HomeworkCheck, ... } } — نفس الجداول اللي بتتحذف مع الطالب
async function archiveAndDeleteStudent({ sequelize, Student, related, studentId, user }) {
  await ensureDeletedStudentArchiveSchema();

  return sequelize.transaction(async (transaction) => {
    const [student] = await selectRows(sequelize, tableNameOf(Student), 'id', studentId, transaction);
    if (!student) return null;

    const relatedRows = {};
    for (const [name, Model] of Object.entries(related)) {
      relatedRows[name] = await selectRows(sequelize, tableNameOf(Model), 'StudentId', studentId, transaction);
    }

    const archive = await DeletedStudentArchive.create({
      student_id: student.id,
      student_code: student.student_code,
      student_name: student.name,
      data: JSON.stringify({ student, related: relatedRows }),
      deleted_by_user_id: user && user.id ? user.id : null,
      deleted_by_name: user && user.name ? user.name : null,
    }, { transaction });

    // نفس ترتيب الحذف القديم: البيانات المرتبطة الأول وبعدين الطالب
    for (const Model of Object.values(related)) {
      await Model.destroy({ where: { StudentId: studentId }, transaction });
    }
    await Student.destroy({ where: { id: studentId }, transaction });

    return archive;
  });
}

// بيرجّع الطالب وكل بياناته بنفس الـ IDs والتواريخ الأصلية. كله في transaction واحدة:
// لو أي حاجة فشلت، مفيش أي حاجة بتتكتب.
async function restoreArchivedStudent({ sequelize, Student, related, archiveId, user }) {
  await ensureDeletedStudentArchiveSchema();

  return sequelize.transaction(async (transaction) => {
    const archive = await DeletedStudentArchive.findByPk(archiveId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!archive) throw new Error('السجل غير موجود في الأرشيف');
    if (archive.restored_at) throw new Error('الطالب ده اترجع قبل كده بالفعل');

    const { student, related: relatedRows } = JSON.parse(archive.data);

    const existing = await Student.findByPk(student.id, { attributes: ['id'], transaction });
    if (existing) throw new Error(`فيه طالب موجود بالفعل بنفس الرقم (${student.id})`);
    if (student.student_code) {
      const sameCode = await Student.findOne({ where: { student_code: student.student_code }, attributes: ['id'], transaction });
      if (sameCode) throw new Error(`فيه طالب موجود بالفعل بنفس الكود (${student.student_code})`);
    }

    // INSERT مباشر بكل الأعمدة والقيم الأصلية (نفس الـ IDs والكود والتواريخ) من غير hooks الـ model
    const queryInterface = sequelize.getQueryInterface();
    await queryInterface.bulkInsert(tableNameOf(Student), [student], { transaction });

    const counts = {};
    for (const [name, Model] of Object.entries(related)) {
      const rows = (relatedRows && relatedRows[name]) || [];
      if (rows.length) {
        await queryInterface.bulkInsert(tableNameOf(Model), rows, { transaction });
      }
      counts[name] = rows.length;
    }

    archive.restored_at = new Date();
    archive.restored_by_name = user && user.name ? user.name : null;
    await archive.save({ transaction });

    return { student, counts };
  });
}

async function listArchivedStudents(limit = 500) {
  await ensureDeletedStudentArchiveSchema();
  return DeletedStudentArchive.findAll({
    attributes: ['id', 'student_id', 'student_code', 'student_name', 'deleted_by_name', 'createdAt', 'restored_at', 'restored_by_name'],
    order: [['createdAt', 'DESC']],
    limit,
  });
}

module.exports = {
  ensureDeletedStudentArchiveSchema,
  archiveAndDeleteStudent,
  restoreArchivedStudent,
  listArchivedStudents,
};
