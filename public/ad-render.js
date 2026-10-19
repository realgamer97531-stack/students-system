// Shared renderer used by BOTH the admin "ad-form" live preview and the real
// student/parent portal popup, so what an admin designs is exactly what shows up.
function escapeAdHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Video inside a design ad: Google Drive (main use), YouTube, Vimeo or a direct file.
// Drive's own player ignores autoplay/mute/loop, the others honour them.
function adVideoEmbedUrl(url, d) {
  const raw = String(url || '').trim();
  const auto = !!d.videoAutoplay;
  const muted = !!d.videoMuted || auto; // browsers only autoplay muted videos
  const loop = !!d.videoLoop;
  const drive = raw.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([a-zA-Z0-9_-]+)/i);
  if (drive) return { kind: 'iframe', src: `https://drive.google.com/file/d/${drive[1]}/preview` };
  const yt = raw.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
  if (yt) {
    const q = `autoplay=${auto ? 1 : 0}&mute=${muted ? 1 : 0}&playsinline=1&rel=0${loop ? `&loop=1&playlist=${yt[1]}` : ''}`;
    return { kind: 'iframe', src: `https://www.youtube.com/embed/${yt[1]}?${q}` };
  }
  const vimeo = raw.match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/([a-zA-Z0-9]+))?/i);
  if (vimeo) {
    const h = vimeo[2] ? `&h=${vimeo[2]}` : '';
    return { kind: 'iframe', src: `https://player.vimeo.com/video/${vimeo[1]}?autoplay=${auto ? 1 : 0}&muted=${muted ? 1 : 0}&loop=${loop ? 1 : 0}&playsinline=1${h}` };
  }
  if (/\.(mp4|m4v|mov|webm)(\?|$)/i.test(raw)) return { kind: 'video', src: raw, auto, muted, loop };
  if (/^https?:\/\//i.test(raw)) return { kind: 'iframe', src: raw };
  return null;
}

function adVideoRatio(d) {
  return { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:3': [4, 3] }[d.videoAspect] || [16, 9];
}

// A video card is as wide as its max width, but never so wide that the video
// alone is taller than ~58% of the screen (tall videos get a narrower card).
function adCardWidth(d, maxWidth) {
  const [rw, rh] = adVideoRatio(d);
  return `width:min(${maxWidth}px, calc(58vh * ${rw} / ${rh}));max-width:100%;`;
}

function renderAdVideo(d, radiusCss) {
  const embed = adVideoEmbedUrl(d.videoUrl, d);
  if (!embed) return '';
  const ratio = adVideoRatio(d).join(' / ');
  // The card itself is sized to the video (see adCardWidth), so the video always fills it edge to edge.
  const box = `position:relative;width:100%;aspect-ratio:${ratio};background:#000;overflow:hidden;border-radius:${radiusCss};`;
  const fill = 'position:absolute;inset:0;width:100%;height:100%;border:0;display:block;';
  const inner = embed.kind === 'video'
    ? `<video src="${escapeAdHtml(embed.src)}" controls playsinline${embed.auto ? ' autoplay' : ''}${embed.muted ? ' muted' : ''}${embed.loop ? ' loop' : ''} style="${fill}object-fit:contain;background:#000;"></video>`
    : `<iframe src="${escapeAdHtml(embed.src)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="origin" style="${fill}"></iframe>`;
  return `<div data-ad-video style="${box}">${inner}</div>`;
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
  const hasText = !!(d.badgeText || d.heading || d.body || (d.buttonEnabled && d.buttonText));
  const videoTop = d.videoUrl && d.videoPosition !== 'bottom'
    ? renderAdVideo(d, hasText || imageBottom ? `${radius}px ${radius}px 0 0` : `${radius}px`)
    : '';
  const videoBottom = d.videoUrl && d.videoPosition === 'bottom'
    ? renderAdVideo(d, hasText || imageTop ? `0 0 ${radius}px ${radius}px` : `${radius}px`)
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

  // A video has no natural width, so the card takes its full max width (still shrinks on small screens).
  const width = d.videoUrl ? adCardWidth(d, maxWidth) : `max-width:${maxWidth}px;width:100%;`;
  const textBlock = d.videoUrl && !hasText ? '' : `
      <div style="padding:${(d.imageUrl || d.videoUrl) ? '20px 24px 24px' : '28px 24px'};">
        ${badge}
        ${heading}
        ${body}
        ${button}
      </div>`;

  return `
    <div style="${background}border-radius:${radius}px;${width}overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.35);text-align:${align};">
      ${videoTop}
      ${imageTop}${textBlock}
      ${imageBottom}
      ${videoBottom}
    </div>
  `;
}

if (typeof window !== 'undefined') {
  window.renderAdPopupContent = renderAdPopupContent;
}
