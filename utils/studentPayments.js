// فلوس الطالب: أسباب حركات الرصيد اللي معناها "دفع فلوس" + تجميعها لكارت "الفلوس اللي دفعها"
// (صفحة الطالب في الموقع وبرنامج الموبايل بيستخدموا نفس الحسبة)

// فلوس اتدفعت في حصة: الحركة مربوطة بالحصة (SessionId) والسبب بيبدأ بده (+ " — " + السبب اللي اتكتب جنبه)
const ATTENDANCE_PAYMENT_REASON = 'دفع نقدي وقت الحضور';
// دفع من ملف الطالب (مش مربوط بحصة)
const MANUAL_PAYMENT_REASON = 'دفع نقدي';
// خانات "مبلغ تاني بسبب تاني": فلوس لحاجة تانية (مش رصيد) — بتتسجل بسببها ومربوطة بالحصة،
// بس مش بتتضاف لرصيد الطالب ولا بتتحسب في "دفع وقت الحضور" (زي دفع البوكليت بالظبط)
const OTHER_PAYMENT_REASON = 'فلوس لسبب تاني';

function cleanLine(amount, reason) {
  const value = Math.round((Number.parseFloat(amount) || 0) * 100) / 100;
  return value > 0 ? { amount: value, reason: String(reason || '').trim().slice(0, 150) } : null;
}

// المبلغ الأساسي (payment_collected + payment_reason اختياري) — ده اللي بيدخل الرصيد
function attendancePaymentLines(body = {}) {
  const line = cleanLine(body.payment_collected, body.payment_reason);
  return line ? [line] : [];
}

// extra_payments: [{ amount, reason }] — فلوس لأسباب تانية (مش بتدخل الرصيد)
function otherPaymentLines(body = {}) {
  let extra = body.extra_payments;
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra); } catch (error) { extra = []; }
  }
  // من فورم الموقع extra_payments[n][...] ممكن توصل object مش array
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) extra = Object.values(extra);
  if (!Array.isArray(extra)) return [];
  return extra.slice(0, 20).map(line => (line ? cleanLine(line.amount, line.reason) : null)).filter(Boolean);
}

function otherPaymentReason(reason) {
  return reason ? `${OTHER_PAYMENT_REASON} — ${reason}` : OTHER_PAYMENT_REASON;
}

// نوع الفلوس اللي دخلت. null = مش فلوس دفعها (نقاط/استرجاع/تعديل سعر)
function paymentKindFromReason(reason) {
  const text = String(reason || '');
  if (text.startsWith(ATTENDANCE_PAYMENT_REASON)) return 'في الحصة';
  if (text.startsWith('دفع وقت التسجيل') || text.startsWith('رصيد أولي')) return 'وقت التسجيل';
  if (text.startsWith('دفع بوكليت') || text.startsWith('تعديل بوكليت')) return 'بوكليت';
  if (text.startsWith(OTHER_PAYMENT_REASON)) return 'سبب تاني';
  if (text.startsWith('شحن رصيد بكود') || text.startsWith('رصيد التسجيل بكود')) return 'كود شحن';
  if (text.startsWith('تحويل إلكتروني')) return 'تحويل إلكتروني';
  if (text.startsWith(MANUAL_PAYMENT_REASON)) return 'دفع من ملف الطالب';
  if (text.startsWith('نقاط:') || text.startsWith('استرجاع') || text.startsWith('تعديل سعر حصة أونلاين')) return null;
  return 'إضافة رصيد يدوية';
}

// transactions: حركات الرصيد (ممكن يكون معاها User و Session.Center)
function studentPaymentsFromTransactions(transactions) {
  return transactions
    .filter(t => Number(t.amount) > 0)
    .map(t => ({ t, kind: paymentKindFromReason(t.reason) }))
    .filter(({ kind }) => kind)
    .map(({ t, kind }) => ({
      id: t.id,
      amount: Number(t.amount) || 0,
      reason: t.reason,
      kind,
      createdAt: t.createdAt,
      userName: t.User ? t.User.name : null,
      sessionId: t.SessionId || null,
      sessionLabel: t.Session ? `حصة ${t.Session.lesson_number}${t.Session.Center ? ' - ' + t.Session.Center.name : ''}` : null,
    }));
}

module.exports = {
  ATTENDANCE_PAYMENT_REASON,
  MANUAL_PAYMENT_REASON,
  OTHER_PAYMENT_REASON,
  attendancePaymentLines,
  otherPaymentLines,
  otherPaymentReason,
  paymentKindFromReason,
  studentPaymentsFromTransactions,
};
