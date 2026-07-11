async function analyzeImageWithAI(imageBuffer, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const base64 = imageBuffer.toString('base64');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: 'استخرج فقط transaction_reference و is_successful_transaction من صورة إيصال دفع Vodafone Cash بصيغة JSON.' },
          { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64 } },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI did not return a readable response');

  return JSON.parse(text.trim());
}

async function checkReceiptWithAI({ imageBuffer, mimeType, PaymentVerification, BookletReservation }) {
  const aiAnalysis = await analyzeImageWithAI(imageBuffer, mimeType);
  const transactionReference = aiAnalysis?.transaction_reference ? String(aiAnalysis.transaction_reference).trim() : '';

  if (!aiAnalysis?.is_successful_transaction || !transactionReference) {
    return {
      success: false,
      message: 'الصورة غير واضحة أو ليست إيصال فودافون كاش صالح.',
    };
  }

  const [usedInWallet, usedInBooklet] = await Promise.all([
    PaymentVerification ? PaymentVerification.findOne({ where: { transactionReference } }) : Promise.resolve(null),
    BookletReservation ? BookletReservation.findOne({ where: { transaction_reference: transactionReference } }) : Promise.resolve(null),
  ]);

  if (usedInWallet || usedInBooklet) {
    return {
      success: false,
      message: 'الإيصال ده مستخدم قبل كده يا بطل!',
    };
  }

  return {
    success: true,
    transactionReference,
    aiAnalysis,
  };
}

module.exports = checkReceiptWithAI;