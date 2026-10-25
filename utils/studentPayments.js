// فلوس الطالب: أسباب حركات الرصيد اللي معناها "دفع فلوس" + تجميعها لكارت "الفلوس اللي دفعها"
// (صفحة الطالب في الموقع وبرنامج الموبايل بيستخدموا نفس الحسبة)

// فلوس اتدفعت في حصة: الحركة مربوطة بالحصة (SessionId) والسبب بيبدأ بده (+ " — " + السبب اللي اتكتب جنبه)
const ATTENDANCE_PAYMENT_REASON = 'دفع نقدي وقت الحضور';
// دفع من ملف الطالب (مش مربوط بحصة)
const MANUAL_PAYMENT_REASON = 'دفع نقدي';

// payment_collected (+ payment_reason اختياري) + extra_payments: [{ amount, reason }] (خانات "مبلغ تاني بسبب تاني")
function attendancePaymentLines(body = {}) {
  const lines = [];
  const push = (amount, reason) => {
    const value = Math.round((Number.parseFloat(amount) || 0) * 100) / 100;
    if (value > 0) lines.push({ amount: value, reason: String(reason || '').trim().slice(0, 150) });
  };
  push(body.payment_collected, body.payment_reason);
  let extra = body.extra_payments;
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra); } catch (error) { extra = []; }
  }
  // من فورم الموقع extra_payments[n][...] ممكن توصل object مش array
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) extra = Object.values(extra);
  if (Array.isArray(extra)) extra.slice(0, 20).forEach(line => { if (line) push(line.amount, line.reason); });
  return lines;
}

// نوع الفلوس اللي دخلت. null = مش فلوس دفعها (نقاط/استرجاع/تعديل سعر)
function paymentKindFromReason(reason) {
  const text = String(reason || '');
  if (text.startsWith(ATTENDANCE_PAYMENT_REASON)) return 'في الحصة';
  if (text.startsWith('دفع وقت التسجيل') || text.startsWith('رصيد أولي')) return 'وقت التسجيل';
  if (text.startsWith('دفع بوكليت') || text.startsWith('تعديل بوكليت')) return 'بوكليت';
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
  attendancePaymentLines,
  paymentKindFromReason,
  studentPaymentsFromTransactions,
};
