const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ===== الإعدادات =====

// أرقام المحفظة المعتمدة لاستقبال التحويلات
const ALLOWED_RECIPIENT_NUMBERS = ['01000733148', '01010796944'];

// اسم المستلم المتوقع (تحقق تنبيهي وليس رافضًا)
const RECIPIENT_NAME_HINTS = ['shady', 'شادي'];

// حفظ صور الإيصالات على القرص
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'public', 'uploads', 'payment-proofs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname) || '.jpg'}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } }); // حد أقصى 8 ميجا للصورة

function normalizeNumber(n) {
  return (n || '').toString().replace(/[^0-9]/g, '');
}

// استدعاء Gemini API الأصلي والمجاني تماماً والمستقر من جوجل
async function extractFromImage(base64, mediaType) {
  const systemPrompt = `أنت نظام استخراج بيانات من صور تحويلات مالية إلكترونية مصرية (InstaPay, Vodafone Cash, Fawry, Orange Cash, إلخ).
اقرأ الصورة المرفقة واستخرج البيانات بدقة شديدة. أجب بصيغة JSON فقط بدون أي نص إضافي أو علامات كود، بالمفاتيح التالية بالضبط:
{
  "is_successful_transaction": boolean,
  "amount": number or null,
  "currency": string or null,
  "recipient_number": string or null,
  "recipient_name": string or null,
  "sender_number": string or null,
  "transaction_date": string or null,
  "transaction_time": string or null,
  "transaction_reference": string or null,
  "payment_method": string or null,
  "notes": string
}
لو أي حقل غير واضح في الصورة اجعله null. لا تخترع بيانات غير موجودة في الصورة، ولا تفترض نجاح العملية إلا لو ظاهر بوضوح.`;

  // نقوم بتمرير المفتاح في الرابط مباشرة كـ key= لمنع أي خطأ في الـ Headers
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: systemPrompt + '\n\nاستخرج بيانات هذه العملية بصيغة JSON فقط.' },
          { inline_data: { mime_type: mediaType, data: base64 } },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error('Gemini API error: ' + errText);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI response had no text content: ' + JSON.stringify(data));
  
  return JSON.parse(text.trim());
}

// deps: { Student, BalanceTransaction, PaymentVerification, verifyPortalToken, sequelize }
module.exports = function (app, deps) {
  const { Student, BalanceTransaction, PaymentVerification, verifyPortalToken, sequelize } = deps;

  app.post('/api/portal/verify-transfer', verifyPortalToken('student'), upload.single('receipt'), async (req, res) => {
    let ex = null;

    try {
      if (!req.file) {
        return res.json({ success: false, message: 'لم يتم إرفاق صورة التحويل' });
      }

      const base64 = fs.readFileSync(req.file.path).toString('base64');
      const mediaType = req.file.mimetype || 'image/jpeg';

      ex = await extractFromImage(base64, mediaType);

      // ===== سلسلة التحقق =====
      if (!ex.is_successful_transaction) {
        return res.json({ success: false, message: 'الصورة لا تُظهر عملية تحويل ناجحة' });
      }
      if (!ex.amount || ex.amount <= 0) {
        return res.json({ success: false, message: 'تعذر قراءة مبلغ صحيح من الصورة' });
      }
      if (!ex.recipient_number || !ALLOWED_RECIPIENT_NUMBERS.includes(normalizeNumber(ex.recipient_number))) {
        return res.json({ success: false, message: 'رقم المستلم في الصورة لا يطابق أرقام المحفظة المعتمدة لدينا' });
      }
      if (!ex.transaction_reference) {
        return res.json({ success: false, message: 'لا يمكن التحقق من العملية بدون رقم عملية واضح في الصورة' });
      }

      const reference = ex.transaction_reference.toString().trim();

      // فحص مبدئي سريع
      const existing = await PaymentVerification.findOne({ where: { transactionReference: reference } });
      if (existing) {
        return res.json({ success: false, message: 'رقم العملية هذا مسجل بالفعل، لا يمكن استخدام نفس التحويل مرتين' });
      }

      let warning = null;
      if (ex.recipient_name) {
        const nameLower = ex.recipient_name.toString().toLowerCase();
        const matches = RECIPIENT_NAME_HINTS.some(h => nameLower.includes(h.toLowerCase()));
        if (!matches) warning = 'اسم المستلم في الصورة غير مؤكد المطابقة، تم القبول لكن يُستحسن المراجعة اليدوية';
      }

      const student = await Student.findByPk(req.portalStudentId);
      if (!student) return res.status(404).json({ success: false, message: 'الطالب غير موجود' });

      // ===== الحفظ والإضافة داخل Transaction واحدة =====
      const newBalance = await sequelize.transaction(async (t) => {
        await PaymentVerification.create({
          StudentId: student.id,
          amount: ex.amount,
          recipientNumber: ex.recipient_number,
          recipientName: ex.recipient_name || null,
          senderNumber: ex.sender_number || null,
          transactionDate: ex.transaction_date || null,
          transactionTime: ex.transaction_time || null,
          transactionReference: reference,
          paymentMethod: ex.payment_method || null,
          status: 'approved',
          imagePath: `/uploads/payment-proofs/${path.basename(req.file.path)}`,
          aiRawResponse: JSON.stringify(ex),
        }, { transaction: t });

        student.balance += Number(ex.amount);
        await student.save({ transaction: t });

        await BalanceTransaction.create({
          StudentId: student.id,
          amount: Number(ex.amount),
          reason: `تحويل إلكتروني تم التحقق منه تلقائيًا (${ex.payment_method || 'محفظة'}) - رقم العملية ${reference}`,
        }, { transaction: t });

        return student.balance;
      });

      return res.json({
        success: true,
        message: 'تم التحقق من التحويل وإضافة الرصيد بنجاح',
        newBalance,
        warning,
      });

    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError') {
        return res.json({ success: false, message: 'رقم العملية هذا مسجل بالفعل، لا يمكن استخدام نفس التحويل مرتين' });
      }

      console.error('verify-transfer error:', error);

      try {
        if (ex) {
          await PaymentVerification.create({
            StudentId: req.portalStudentId,
            amount: ex.amount || 0,
            recipientNumber: ex.recipient_number || null,
            recipientName: ex.recipient_name || null,
            transactionReference: (ex.transaction_reference || 'unknown') + '_FAILED_' + Date.now(),
            status: 'rejected',
            rejectionReason: error.message,
            imagePath: req.file ? `/uploads/payment-proofs/${path.basename(req.file.path)}` : null,
            aiRawResponse: JSON.stringify(ex),
          });
        }
      } catch (logErr) {
        console.error('failed to log rejected verification:', logErr);
      }

      res.status(500).json({ success: false, message: 'حصلت مشكلة أثناء التحقق من الصورة، حاول مرة أخرى' });
    }
  });
};