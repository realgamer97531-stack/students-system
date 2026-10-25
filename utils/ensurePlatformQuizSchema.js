// بيعمل جداول اختبار المنصة لو مش موجودة.
// CREATE TABLE IF NOT EXISTS فقط — مفيش أي تعديل على جداول موجودة، ولا حذف بيانات.
const PlatformQuiz = require('../models/PlatformQuiz');
const PlatformQuizQuestion = require('../models/PlatformQuizQuestion');
const PlatformQuizAttempt = require('../models/PlatformQuizAttempt');
const PlatformQuizSetting = require('../models/PlatformQuizSetting');

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

function ensurePlatformQuizSchema() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await syncTolerant(PlatformQuizSetting);
      await syncTolerant(PlatformQuiz);
      await syncTolerant(PlatformQuizQuestion);
      await syncTolerant(PlatformQuizAttempt);
    })().catch((error) => {
      ensurePromise = null; // يسمح بإعادة المحاولة عند إعادة الاتصال
      throw error;
    });
  }
  return ensurePromise;
}

module.exports = ensurePlatformQuizSchema;
