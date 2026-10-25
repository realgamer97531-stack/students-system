// رفع صور اختبار المنصة على هوستينجر (quiz_upload.php) — Railway مفيهوش تخزين دايم.
// محتاج QUIZ_UPLOAD_SECRET في الـ environment (نفس المفتاح اللي في quiz_upload_key.php على هوستينجر).
const DEFAULT_URL = 'https://shadyelsharkawy.com/quiz_upload.php';

function quizUploadConfigured() {
  return String(process.env.QUIZ_UPLOAD_SECRET || '').length >= 24;
}

async function uploadQuizImage(file, folder = 'questions') {
  if (!quizUploadConfigured()) {
    throw new Error('رفع الصور على هوستينجر مش متظبط (QUIZ_UPLOAD_SECRET)');
  }
  const form = new FormData();
  form.append('folder', folder);
  form.append('image', new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' }), file.originalname || 'image');
  const response = await fetch(process.env.QUIZ_UPLOAD_URL || DEFAULT_URL, {
    method: 'POST',
    headers: { 'X-Quiz-Upload-Secret': process.env.QUIZ_UPLOAD_SECRET },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  let data = null;
  try { data = await response.json(); } catch (_) { /* رد مش JSON */ }
  if (!response.ok || !data || !data.success || !data.url) {
    throw new Error('فشل رفع الصورة: ' + ((data && data.message) || `HTTP ${response.status}`));
  }
  return data.url;
}

module.exports = { uploadQuizImage, quizUploadConfigured };
