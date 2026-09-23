// نظام بث الفيديوهات الجديد - قسم منفصل تمامًا عن أي كود فيديو تاني في البوابة.
// بيجيب الفيديوهات المتاحة للصفحة الحالية وبيعرضها كزر عائم + لوحة مصغّرة، بدون التأثير على أي عنصر تاني في الصفحة.
(function () {
  function getCurrentPageKey() {
    const path = window.location.pathname;
    const file = path.substring(path.lastIndexOf('/') + 1) || 'student.html';
    return file.replace(/\.html$/, '') || 'student';
  }

  function escapeVideoHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function toEmbedUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes('youtube.com') && u.searchParams.get('v')) {
        return `https://www.youtube.com/embed/${u.searchParams.get('v')}`;
      }
      if (u.hostname === 'youtu.be') {
        return `https://www.youtube.com/embed/${u.pathname.replace('/', '')}`;
      }
      if (u.hostname.includes('vimeo.com')) {
        const id = u.pathname.split('/').filter(Boolean).pop();
        return `https://player.vimeo.com/video/${id}`;
      }
      if (u.hostname.toLowerCase().includes('mediadelivery.net')) {
        u.searchParams.set('autoplay', 'true');
        u.searchParams.set('muted', 'false');
        u.searchParams.set('responsive', 'true');
        return u.toString();
      }
    } catch (e) {
      // رابط غير صالح كـ URL كامل - هنتعامل معاه كملف فيديو مباشر
    }
    return null;
  }

  let videosCache = [];
  let token = null;

  async function loadVideos() {
    try {
      token = localStorage.getItem('portal_token');
      const portalType = localStorage.getItem('portal_type');
      if (!token || portalType !== 'student') return;

      const page = encodeURIComponent(getCurrentPageKey());
      const res = await fetch(`${API_BASE_URL}/api/portal/student/video-broadcasts?page=${page}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.success || !Array.isArray(data.videos) || data.videos.length === 0) return;

      videosCache = data.videos;
      renderLauncher();
    } catch (e) {
      // نظام الفيديوهات لازم أبدًا ما يعطل باقي البوابة
    }
  }

  function renderLauncher() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'vb-launcher';
    btn.innerHTML = `🎬 <span>فيديوهات (${videosCache.length})</span>`;
    btn.style.cssText = [
      'position:fixed', 'bottom:20px', 'left:20px', 'z-index:19000',
      'background:#4338CA', 'color:#fff', 'border:none', 'border-radius:999px',
      'padding:12px 18px', 'font-weight:700', 'font-size:14px', 'cursor:pointer',
      'box-shadow:0 10px 30px rgba(67,56,202,0.4)', 'display:flex', 'align-items:center', 'gap:6px',
    ].join(';');
    btn.addEventListener('click', renderPanel);
    document.body.appendChild(btn);
  }

  function closeOverlay(overlay) {
    overlay.remove();
  }

  function renderPanel() {
    const existing = document.getElementById('vb-panel-overlay');
    if (existing) { closeOverlay(existing); return; }

    const overlay = document.createElement('div');
    overlay.id = 'vb-panel-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:20000;background:rgba(15,23,42,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(overlay); });

    const card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:18px;max-width:520px;width:100%;max-height:82vh;overflow-y:auto;padding:20px;position:relative;';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'position:absolute;top:10px;left:14px;background:none;border:none;font-size:26px;line-height:1;cursor:pointer;color:#333;';
    closeBtn.addEventListener('click', () => closeOverlay(overlay));
    card.appendChild(closeBtn);

    const title = document.createElement('h5');
    title.textContent = '🎬 فيديوهات متاحة في هذه الصفحة';
    title.style.cssText = 'margin:0 0 16px;font-weight:800;color:#181527;';
    card.appendChild(title);

    videosCache.forEach((video) => {
      const item = document.createElement('div');
      item.style.cssText = 'border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin-bottom:12px;cursor:pointer;';
      item.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div>
            <div style="font-weight:700;color:#181527;">${escapeVideoHtml(video.title)}</div>
            ${video.description ? `<div style="font-size:13px;color:#666;margin-top:4px;">${escapeVideoHtml(video.description)}</div>` : ''}
            ${video.session_label ? `<div style="font-size:12px;color:#4338CA;margin-top:4px;">🔗 ${escapeVideoHtml(video.session_label)}</div>` : ''}
          </div>
          <div>
            ${video.locked
              ? `<span style="background:#fef3c7;color:#92400e;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700;">💰 ${escapeVideoHtml(video.price)} ج</span>`
              : `<span style="background:#dcfce7;color:#166534;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700;">مجاني</span>`}
          </div>
        </div>
      `;
      item.addEventListener('click', () => openVideo(video));
      card.appendChild(item);
    });

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  async function openVideo(video) {
    if (!video.locked && video.video_url) {
      showPlayer(video.video_url);
      return;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/portal/student/video-broadcasts/${video.id}/purchase`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();

      if (data.success) {
        showPlayer(data.video_url);
        return;
      }

      if (data.requiresPayment) {
        if (!window.confirm(data.message || `هل توافق على دفع ${data.price} ج لمشاهدة هذا الفيديو؟`)) return;
        const res2 = await fetch(`${API_BASE_URL}/api/portal/student/video-broadcasts/${video.id}/purchase`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm_payment: true }),
        });
        const data2 = await res2.json();
        if (data2.success) {
          showPlayer(data2.video_url);
        } else {
          window.alert(data2.message || 'حصلت مشكلة أثناء الدفع');
        }
        return;
      }

      window.alert(data.message || 'تعذّر فتح الفيديو');
    } catch (e) {
      window.alert('حصلت مشكلة، حاول مرة أخرى');
    }
  }

  function showPlayer(videoUrl) {
    const panelOverlay = document.getElementById('vb-panel-overlay');
    if (panelOverlay) closeOverlay(panelOverlay);

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:21000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px;';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:100%;max-width:900px;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden;';

    const embedUrl = toEmbedUrl(videoUrl);
    if (embedUrl) {
      wrap.innerHTML = `<iframe src="${escapeVideoHtml(embedUrl)}" style="width:100%;height:100%;border:0;" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
    } else {
      wrap.innerHTML = `<video src="${escapeVideoHtml(videoUrl)}" controls autoplay style="width:100%;height:100%;"></video>`;
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '× إغلاق';
    closeBtn.style.cssText = 'position:absolute;top:-40px;left:0;background:none;border:none;color:#fff;font-size:16px;cursor:pointer;';
    closeBtn.addEventListener('click', () => overlay.remove());
    wrap.appendChild(closeBtn);

    overlay.appendChild(wrap);
    document.body.appendChild(overlay);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadVideos);
  } else {
    loadVideos();
  }
})();
