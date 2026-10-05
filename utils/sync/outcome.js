// بنحدد هل نتيجة طلب معين "نجحت" ولا "اترفضت"، بنفس القاعدة على الجهاز وعلى السيرفر.
// الصفحات هنا مش موحدة: فيه JSON فيه success، وفيه صفحات HTML بتبدأ بـ ❌ أو ⛔ لما يحصل رفض.
function judgeOutcome(status, contentType, bodyText) {
  if (status >= 400) return { ok: false, message: extractMessage(contentType, bodyText) || `HTTP ${status}` };
  const text = String(bodyText || '').trim();
  if (/json/i.test(contentType || '')) {
    try {
      const data = JSON.parse(text);
      if (data && data.success === false) return { ok: false, message: data.message || data.error || 'رفض بدون رسالة' };
      return { ok: true, message: (data && data.message) || '' };
    } catch (e) {
      return { ok: true, message: '' };
    }
  }
  if (/^(❌|⛔)/u.test(text)) return { ok: false, message: text.slice(0, 500) };
  return { ok: true, message: '' };
}

function extractMessage(contentType, bodyText) {
  const text = String(bodyText || '').trim();
  if (/json/i.test(contentType || '')) {
    try {
      const data = JSON.parse(text);
      return data.message || data.error || '';
    } catch (e) { /* not JSON after all */ }
  }
  // صفحة HTML: ناخد النص من غير الوسوم
  return text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

module.exports = { judgeOutcome, extractMessage };
