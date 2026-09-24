// بيعمل جدولين جداد بس (popupquestions / popupquestionanswers) لو مش موجودين.
// CREATE TABLE IF NOT EXISTS فقط — مفيش أي تعديل على جداول موجودة، ولا حذف بيانات.
const PopupQuestion = require('../models/PopupQuestion');
const PopupQuestionAnswer = require('../models/PopupQuestionAnswer');

let ensurePromise = null;

function ensurePopupQuestionSchema() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await PopupQuestion.sync();
      await PopupQuestionAnswer.sync();
      // جدول الأسئلة اتعمل قبل كده: بنضيف أعمدة صور الاختيارات لو مش موجودة (NULL، مفيش أي تأثير على البيانات)
      const sequelize = PopupQuestion.sequelize;
      for (const column of ['choice_a_image', 'choice_b_image', 'choice_c_image', 'choice_d_image']) {
        const [rows] = await sequelize.query("SHOW COLUMNS FROM `popupquestions` LIKE '" + column + "'");
        if (!rows || rows.length === 0) {
          await sequelize.query('ALTER TABLE `popupquestions` ADD COLUMN `' + column + '` VARCHAR(500) NULL');
        }
      }
    })().catch((error) => {
      ensurePromise = null; // يسمح بإعادة المحاولة عند إعادة الاتصال
      throw error;
    });
  }
  return ensurePromise;
}

module.exports = ensurePopupQuestionSchema;
