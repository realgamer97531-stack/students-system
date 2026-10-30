// بيعمل جداول اختبار المنصة لو مش موجودة.
// CREATE TABLE IF NOT EXISTS + إضافة أعمدة جديدة بس — مفيش حذف بيانات.
const { DataTypes } = require('sequelize');
const PlatformQuiz = require('../models/PlatformQuiz');
const PlatformQuizQuestion = require('../models/PlatformQuizQuestion');
const PlatformQuizAttempt = require('../models/PlatformQuizAttempt');
const PlatformQuizSetting = require('../models/PlatformQuizSetting');
const PlatformQuizExam = require('../models/PlatformQuizExam');
const PlatformQuizPayment = require('../models/PlatformQuizPayment');

let ensurePromise = null;

// server.js بيعمل sequelize.sync() عام وقت التحميل، فممكن الجدول/الإندكس يتعمل من هناك في نفس اللحظة
async function syncTolerant(model) {
  try {
    await model.sync();
  } catch (error) {
    const code = error.original?.code || error.parent?.code;
    if (code !== 'ER_DUP_KEYNAME' && code !== 'ER_TABLE_EXISTS_ERROR') throw error;
  }
}

// أعمدة الشامل على جدول الاختبارات الموجود
async function ensureShamelColumns() {
  const queryInterface = PlatformQuiz.sequelize.getQueryInterface();
  const columns = await queryInterface.describeTable('platform_quizzes');
  const wanted = {
    is_shamel: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    price: { type: DataTypes.FLOAT, allowNull: true },
  };
  for (const [name, definition] of Object.entries(wanted)) {
    if (columns[name]) continue;
    try {
      await queryInterface.addColumn('platform_quizzes', name, definition);
    } catch (error) {
      if ((error.original?.code || error.parent?.code) !== 'ER_DUP_FIELDNAME') throw error;
    }
  }
}

function ensurePlatformQuizSchema() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await syncTolerant(PlatformQuizSetting);
      await syncTolerant(PlatformQuiz);
      await ensureShamelColumns();
      await syncTolerant(PlatformQuizQuestion);
      await syncTolerant(PlatformQuizAttempt);
      await syncTolerant(PlatformQuizExam);
      await syncTolerant(PlatformQuizPayment);
    })().catch((error) => {
      ensurePromise = null; // يسمح بإعادة المحاولة عند إعادة الاتصال
      throw error;
    });
  }
  return ensurePromise;
}

module.exports = ensurePlatformQuizSchema;
