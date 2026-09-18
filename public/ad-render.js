// Shared renderer used by BOTH the admin "ad-form" live preview and the real
// student/parent portal popup, so what an admin designs is exactly what shows up.
function escapeAdHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderAdPopupContent(ad) {
  if (!ad) return '';

  if (ad.ad_type === 'image') {
    if (!ad.image_url) return '';
    return `<img src="${escapeAdHtml(ad.image_url)}" alt="" style="display:block;max-width:100%;max-height:80vh;border-radius:16px;">`;
  }

  const d = ad.design || {};
  const radius = d.borderRadius != null && d.borderRadius !== '' ? d.borderRadius : 18;
  const maxWidth = d.maxWidth || 420;
  const align = d.textAlign || 'center';

  let background;
  if (d.backgroundImageUrl) {
    background = `background-image:url('${escapeAdHtml(d.backgroundImageUrl)}');background-size:cover;background-position:center;`;
  } else if (d.backgroundGradientTo) {
    background = `background:linear-gradient(135deg, ${escapeAdHtml(d.backgroundColor || '#4338CA')}, ${escapeAdHtml(d.backgroundGradientTo)});`;
  } else {
    background = `background:${escapeAdHtml(d.backgroundColor || '#4338CA')};`;
  }

  const imageTop = d.imageUrl && d.imagePosition !== 'bottom'
    ? `<img src="${escapeAdHtml(d.imageUrl)}" alt="" style="width:100%;display:block;border-radius:${radius}px ${radius}px 0 0;">`
    : '';
  const imageBottom = d.imageUrl && d.imagePosition === 'bottom'
    ? `<img src="${escapeAdHtml(d.imageUrl)}" alt="" style="width:100%;display:block;border-radius:0 0 ${radius}px ${radius}px;margin-top:16px;">`
    : '';
  const badge = d.badgeText
    ? `<span style="display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:700;margin-bottom:10px;background:${escapeAdHtml(d.badgeColor || 'rgba(255,255,255,0.25)')};color:#fff;">${escapeAdHtml(d.badgeText)}</span>`
    : '';
  const heading = d.heading
    ? `<h3 style="margin:0 0 8px;font-weight:800;color:${escapeAdHtml(d.headingColor || '#ffffff')};font-size:${d.headingSize || 22}px;">${escapeAdHtml(d.heading)}</h3>`
    : '';
  const body = d.body
    ? `<p style="margin:0;white-space:pre-line;color:${escapeAdHtml(d.bodyColor || '#ffffff')};font-size:${d.bodySize || 15}px;line-height:1.6;">${escapeAdHtml(d.body)}</p>`
    : '';
  const button = d.buttonEnabled && d.buttonText
    ? `<div style="margin-top:16px;"><span data-ad-button style="display:inline-block;padding:10px 22px;border-radius:10px;font-weight:700;cursor:pointer;background:${escapeAdHtml(d.buttonColor || '#14B8A6')};color:${escapeAdHtml(d.buttonTextColor || '#ffffff')};">${escapeAdHtml(d.buttonText)}</span></div>`
    : '';

  return `
    <div style="${background}border-radius:${radius}px;max-width:${maxWidth}px;width:100%;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.35);text-align:${align};">
      ${imageTop}
      <div style="padding:${d.imageUrl ? '20px 24px 24px' : '28px 24px'};">
        ${badge}
        ${heading}
        ${body}
        ${button}
      </div>
      ${imageBottom}
    </div>
  `;
}

if (typeof window !== 'undefined') {
  window.renderAdPopupContent = renderAdPopupContent;
}
