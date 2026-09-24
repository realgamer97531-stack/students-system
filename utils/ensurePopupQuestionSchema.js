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
    })().catch((error) => {
      ensurePromise = null; // يسمح بإعادة المحاولة عند إعادة الاتصال
      throw error;
    });
  }
  return ensurePromise;
}

module.exports = ensurePopupQuestionSchema;
