// Shared, dependency-free video URL detection + embedding helpers.
// Used by lesson-view.html (full player, with watch-progress tracking) and
// by the lightweight questions-preview modal on lessons.html (no tracking).

function normalizeMediaDeliveryUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase().includes('mediadelivery.net')) {
      parsed.searchParams.set('autoplay', 'true');
      parsed.searchParams.set('muted', 'true');
      parsed.searchParams.set('responsive', 'true');
      return parsed.toString();
    }
  } catch (_) {
    return url;
  }
  return url;
}

function normalizeVimeoUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== 'vimeo.com' && !hostname.endsWith('.vimeo.com')) return null;

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const videoIdMatch = parsed.pathname.match(/(?:^|\/)(\d+)(?:$|\/)/);
    if (!videoIdMatch) return null;

    const playerUrl = new URL(`https://player.vimeo.com/video/${videoIdMatch[1]}`);
    const videoIdIndex = pathParts.indexOf(videoIdMatch[1]);
    const pathHash = videoIdIndex >= 0 ? pathParts[videoIdIndex + 1] : null;
    const privateHash = parsed.searchParams.get('h') || pathHash;
    if (privateHash) playerUrl.searchParams.set('h', privateHash);
    for (const parameter of ['app_id', 'referrer']) {
      const value = parsed.searchParams.get(parameter);
      if (value) playerUrl.searchParams.set(parameter, value);
    }
    playerUrl.searchParams.set('autoplay', '0');
    playerUrl.searchParams.set('playsinline', '1');
    return playerUrl.toString();
  } catch (_) {
    return null;
  }
}

function detectVideoSource(url) {
  if (!url) return { type: 'unknown' };
  const trimmedUrl = String(url).trim();
  const ytMatch = trimmedUrl.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
  if (ytMatch) return { type: 'youtube', id: ytMatch[1] };
  const driveMatch = trimmedUrl.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i);
  if (driveMatch) return { type: 'drive', id: driveMatch[1] };
  const vimeoUrl = normalizeVimeoUrl(trimmedUrl);
  if (vimeoUrl) return { type: 'vimeo', url: vimeoUrl };
  const mediaMatch = trimmedUrl.match(/mediadelivery\.net/i);
  if (mediaMatch) return { type: 'mediadelivery', url: normalizeMediaDeliveryUrl(trimmedUrl) };
  if (/^https?:\/\//i.test(trimmedUrl)) return { type: 'iframe', url: trimmedUrl };
  return { type: 'direct', url: trimmedUrl };
}

// Lightweight, non-tracking embed used for previews (e.g. the questions
// modal). Returns a DOM element ready to be appended to a container.
function buildEmbedElement(part, apiBaseUrl) {
  const rawUrl = part.sourceType === 'upload' ? `${apiBaseUrl}${part.filePath}` : (part.videoUrl || part.filePath || '');
  const source = part.sourceType === 'upload' ? { type: 'direct', url: rawUrl } : detectVideoSource(rawUrl);
  const playerFrame = document.createElement('div');
  playerFrame.className = 'player-frame';

  if (source.type === 'direct') {
    const video = document.createElement('video');
    video.className = 'w-100';
    video.controls = true;
    video.style.maxHeight = '480px';
    video.src = source.url;
    playerFrame.appendChild(video);
  } else if (source.type === 'youtube') {
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${source.id}`;
    iframe.width = '100%'; iframe.height = '480';
    iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
    iframe.style.border = 'none';
    iframe.setAttribute('allowfullscreen', 'true');
    playerFrame.appendChild(iframe);
  } else if (source.type === 'drive') {
    const iframe = document.createElement('iframe');
    iframe.src = `https://drive.google.com/file/d/${source.id}/preview`;
    iframe.width = '100%'; iframe.height = '480'; iframe.allow = 'autoplay'; iframe.style.border = 'none';
    playerFrame.appendChild(iframe);
  } else if (source.type === 'vimeo' || source.type === 'mediadelivery' || source.type === 'iframe') {
    const iframe = document.createElement('iframe');
    iframe.src = source.url;
    iframe.width = '100%'; iframe.height = '480';
    iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write';
    iframe.style.border = 'none';
    iframe.setAttribute('referrerpolicy', 'origin');
    iframe.setAttribute('allowfullscreen', 'true');
    playerFrame.appendChild(iframe);
  } else {
    playerFrame.innerHTML = "<div class='alert alert-warning mb-0'>صيغة الرابط غير مدعومة</div>";
  }

  return playerFrame;
}
