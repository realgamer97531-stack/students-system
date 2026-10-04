// QR الطالب بالتصميم الجديد: نقط مدوّرة بتدرج ألوان البراند، عيون الزوايا مدوّرة، ولوجو قرش كرتوني في النص.
// بيطلع SVG (من غير أي مكتبات رسم). تصحيح الأخطاء على أعلى مستوى (H = 30%) عشان اللوجو في النص
// مايأثرش على القراءة — اللوجو بيغطي أقل من 8% من الكود.
const QRCode = require('qrcode');

const MODULE = 10; // حجم المربع الواحد بوحدات الـ SVG
const QUIET = 3; // هامش أبيض حوالين الكود (بالمربعات)
const COLORS = {
  from: '#312E81', // indigo-900
  to: '#0F766E', // teal-700
  eye: '#312E81',
  eyeInner: '#0F766E',
};

// قرش كرتوني (مرسوم على مربع 100×100، باصص لليمين)
const SHARK_SVG = `
  <defs>
    <linearGradient id="sharkBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#60A5FA"/>
      <stop offset="1" stop-color="#2563EB"/>
    </linearGradient>
  </defs>
  <path d="M17 55 L3 38 Q9 52 4 70 Z" fill="#2563EB" stroke="#1E3A8A" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M43 34 Q49 15 63 9 Q58 22 61 35 Z" fill="#3B82F6" stroke="#1E3A8A" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M14 56 C20 38 46 28 68 33 C82 36 93 46 96 56 C92 66 80 73 62 75 C40 77 22 70 14 56 Z" fill="url(#sharkBody)" stroke="#1E3A8A" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M30 63 C46 72 72 72 92 61 C86 69 76 74 62 75 C46 76 37 71 30 63 Z" fill="#FFFFFF" stroke="#1E3A8A" stroke-width="2" stroke-linejoin="round"/>
  <path d="M47 69 Q50 81 41 89 Q43 79 40 71 Z" fill="#3B82F6" stroke="#1E3A8A" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M55 45 Q52 51 55 57 M60 44 Q57 50 60 56" fill="none" stroke="#1E3A8A" stroke-width="2" stroke-linecap="round"/>
  <circle cx="76" cy="47" r="6.5" fill="#FFFFFF" stroke="#1E3A8A" stroke-width="2"/>
  <circle cx="77.5" cy="47.5" r="3.6" fill="#0F172A"/>
  <circle cx="79" cy="46" r="1.3" fill="#FFFFFF"/>
  <ellipse cx="70" cy="58" rx="4" ry="2.4" fill="#F9A8D4" opacity="0.8"/>
  <path d="M74 61 Q83 66 92 59" fill="#FFFFFF" stroke="#1E3A8A" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M78 62.6 L80 65.6 L82 63.6 L84.5 65.2 L86 62.4" fill="none" stroke="#1E3A8A" stroke-width="1.2" stroke-linejoin="round"/>
`;

function isInFinder(row, col, size) {
  const inBox = (r0, c0) => row >= r0 && row < r0 + 7 && col >= c0 && col < c0 + 7;
  return inBox(0, 0) || inBox(0, size - 7) || inBox(size - 7, 0);
}

function finderSvg(row, col) {
  const x = (col + QUIET) * MODULE;
  const y = (row + QUIET) * MODULE;
  const outer = 7 * MODULE;
  const stroke = MODULE;
  return `
    <rect x="${x + stroke / 2}" y="${y + stroke / 2}" width="${outer - stroke}" height="${outer - stroke}" rx="${MODULE * 1.8}" fill="none" stroke="${COLORS.eye}" stroke-width="${stroke}"/>
    <rect x="${x + 2 * MODULE}" y="${y + 2 * MODULE}" width="${3 * MODULE}" height="${3 * MODULE}" rx="${MODULE * 0.9}" fill="${COLORS.eyeInner}"/>`;
}

function studentQrSvg(text) {
  const qr = QRCode.create(String(text), { errorCorrectionLevel: 'H' });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const total = (size + QUIET * 2) * MODULE;

  // مساحة اللوجو في النص (عدد فردي من المربعات عشان تبقى متمركزة)
  let logoModules = Math.floor(size * 0.27);
  if (logoModules % 2 === 0) logoModules += 1;
  const logoStart = Math.floor((size - logoModules) / 2);
  const logoEnd = logoStart + logoModules;
  const inLogo = (r, c) => r >= logoStart && r < logoEnd && c >= logoStart && c < logoEnd;

  const dots = [];
  const pad = MODULE * 0.06;
  const dot = MODULE - pad * 2;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!data[r * size + c] || isInFinder(r, c, size) || inLogo(r, c)) continue;
      const x = (c + QUIET) * MODULE + pad;
      const y = (r + QUIET) * MODULE + pad;
      dots.push(`<rect x="${x}" y="${y}" width="${dot}" height="${dot}" rx="${MODULE * 0.32}"/>`);
    }
  }

  const logoSize = logoModules * MODULE;
  const logoX = (logoStart + QUIET) * MODULE;
  const center = logoX + logoSize / 2;
  const badgeRadius = logoSize / 2 - MODULE * 0.3;
  const sharkSize = badgeRadius * 1.8;
  const sharkScale = sharkSize / 100;
  const sharkOffset = center - sharkSize / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}">
  <defs>
    <linearGradient id="qrGradient" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${COLORS.from}"/>
      <stop offset="1" stop-color="${COLORS.to}"/>
    </linearGradient>
  </defs>
  <rect width="${total}" height="${total}" rx="${MODULE * 2.5}" fill="#FFFFFF"/>
  <g fill="url(#qrGradient)">${dots.join('')}</g>
  ${finderSvg(0, 0)}${finderSvg(0, size - 7)}${finderSvg(size - 7, 0)}
  <circle cx="${center}" cy="${center}" r="${badgeRadius}" fill="#FFFFFF" stroke="url(#qrGradient)" stroke-width="${MODULE * 0.45}"/>
  <g transform="translate(${sharkOffset} ${sharkOffset + sharkSize * 0.02}) scale(${sharkScale})">${SHARK_SVG}</g>
</svg>`;
}

function studentQrDataUrl(text) {
  return 'data:image/svg+xml;base64,' + Buffer.from(studentQrSvg(text), 'utf8').toString('base64');
}

module.exports = { studentQrSvg, studentQrDataUrl };
