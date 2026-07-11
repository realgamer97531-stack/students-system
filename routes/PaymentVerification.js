const multer = require('multer');
const crypto = require('crypto');
const { Op } = require('sequelize');
const ensureBookletReservationSchema = require('../utils/ensureBookletReservationSchema');
const checkReceiptWithAI = require('../utils/checkReceiptWithAI');

// ===== الإعدادات =====

// أرقام المحفظة المعتمدة لاستقبال التحويلات
const ALLOWED_RECIPIENT_NUMBERS = ['01000733148', '01010796944'];

// اسم المستلم المتوقع (تحقق تنبيهي وليس رافضًا)
const RECIPIENT_NAME_HINTS = ['shady', 'شادي'];

// الصورة بتتخزن في الذاكرة المؤقتة (RAM) بس أثناء الطلب، ومفيش أي كتابة على قرص السيرفر إطلاقًا
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // حد أقصى 8 ميجا للصورة
});

function normalizeNumber(n) {
  return (n || '').toString().replace(/[^0-9]/g, '');
}

// رفع الصورة إلى Cloudinary (تخزين خارجي دائم، مش على قرص السيرفر)
async function uploadToCloudinary(base64, mediaType) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'payment-proofs';

  const paramsToSign = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(paramsToSign).digest('hex');

  const form = new URLSearchParams();
  form.append('file', `data:${mediaType};base64,${base64}`);
  form.append('api_key', apiKey);
  form.append('timestamp', timestamp);
  form.append('folder', folder);
  form.append('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error('Cloudinary upload error: ' + errText);
  }

  const data = await response.json();
  return data.secure_url;
}

// deps: { Student, BalanceTransaction, PaymentVerification, verifyPortalToken, sequelize }
module.exports = function (app, deps) {
  const { Student, BalanceTransaction, PaymentVerification, verifyPortalToken, sequelize } = deps;
  const Booklet = require('../models/Booklet');
  const BookletReservation = require('../models/BookletReservation');

  // ===== صفحة مراجعة منفصلة: بس بتعرض عمليات التحقق الناجحة (قراءة فقط) =====
  app.get('/admin/payment-verifications', async (req, res) => {
    try {
      if (!req.session || req.session.userRole !== 'admin') {
        return res.status(403).send('⛔ هذه الصفحة للأدمن فقط');
      }

      const { status, from, to, tab } = req.query;
      const currentTab = tab || 'reservations';

      const records = await PaymentVerification.findAll({
        where: { status: 'approved' },
        include: [Student],
        order: [['createdAt', 'DESC']],
        limit: 300,
      });

      const whereClause = {};
      if (status) whereClause.status = status;
      if (from && to) {
        whereClause.createdAt = { [Op.between]: [from + ' 00:00:00', to + ' 23:59:59'] };
      }

      await ensureBookletReservationSchema(sequelize);

      const reservations = await BookletReservation.findAll({
        where: whereClause,
        include: [
          { model: Student },
          { model: Booklet },
        ],
        order: [['createdAt', 'DESC']],
        limit: 300,
      });

      res.render('payment-verifications', {
        records,
        reservations,
        currentTab,
        filters: { status, from, to },
      });
    } catch (error) {
      console.error(error);
      res.status(500).send('❌ حصلت مشكلة: ' + error.message);
    }
  });

  app.post('/api/portal/verify-transfer', verifyPortalToken('student'), upload.single('receipt'), async (req, res) => {
    let ex = null;
    let base64 = null;
    let mediaType = null;

    try {
      if (!req.file) {
        return res.json({ success: false, message: 'لم يتم إرفاق صورة التحويل' });
      }

      mediaType = req.file.mimetype || 'image/jpeg';

      const receiptCheck = await checkReceiptWithAI({
        imageBuffer: req.file.buffer,
        mimeType: mediaType,
        PaymentVerification,
        BookletReservation,
      });

      if (!receiptCheck.success) {
        return res.json({ success: false, message: receiptCheck.message });
      }

      ex = receiptCheck.aiAnalysis;

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

      const reference = receiptCheck.transactionReference;

      let warning = null;
      if (ex.recipient_name) {
        const nameLower = ex.recipient_name.toString().toLowerCase();
        const matches = RECIPIENT_NAME_HINTS.some(h => nameLower.includes(h.toLowerCase()));
        if (!matches) warning = 'اسم المستلم في الصورة غير مؤكد المطابقة، تم القبول لكن يُستحسن المراجعة اليدوية';
      }

      const student = await Student.findByPk(req.portalStudentId);
      if (!student) return res.status(404).json({ success: false, message: 'الطالب غير موجود' });

      // رفع الصورة لـ Cloudinary قبل الحفظ (لو فشل الرفع، نوقف العملية كلها بدل ما نضيف رصيد من غير إثبات محفوظ)
      const imageUrl = await uploadToCloudinary(req.file.buffer.toString('base64'), mediaType);

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
          imagePath: imageUrl,
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