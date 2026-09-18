// Fetches ads targeted at the logged-in student/parent and shows them as a
// closeable popup on page load. Closing only dismisses the current page view
// (nothing is persisted), so an active ad can reappear on the next page load.
(function () {
  async function loadAndShowAds() {
    try {
      const adsToken = localStorage.getItem('portal_token');
      const adsPortalType = localStorage.getItem('portal_type');
      if (!adsToken || (adsPortalType !== 'student' && adsPortalType !== 'parent')) return;

      const res = await fetch(`${API_BASE_URL}/api/portal/${adsPortalType}/ads`, {
        headers: { Authorization: `Bearer ${adsToken}` },
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.success || !Array.isArray(data.ads) || data.ads.length === 0) return;

      showAdsQueue(data.ads.slice());
    } catch (e) {
      // Ads must never block the portal.
    }
  }

  function showAdsQueue(queue) {
    if (queue.length === 0) return;
    const ad = queue.shift();
    const content = window.renderAdPopupContent ? window.renderAdPopupContent(ad) : '';
    if (!content) { showAdsQueue(queue); return; }

    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:20000',
      'background:rgba(15,23,42,0.6)', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:20px',
      'animation:ad-popup-fade-in 0.2s ease',
    ].join(';');

    const style = document.createElement('style');
    style.textContent = '@keyframes ad-popup-fade-in{from{opacity:0}to{opacity:1}}';
    overlay.appendChild(style);

    const card = document.createElement('div');
    card.style.cssText = 'position:relative;max-width:92vw;max-height:90vh;display:flex;';
    card.innerHTML = content;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'إغلاق');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = [
      'position:absolute', 'top:-14px', 'left:-14px',
      'width:34px', 'height:34px', 'border-radius:50%',
      'background:#fff', 'color:#181527', 'border:none',
      'font-size:22px', 'line-height:1', 'cursor:pointer',
      'box-shadow:0 4px 14px rgba(0,0,0,0.25)', 'z-index:1',
    ].join(';');

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      overlay.remove();
      showAdsQueue(queue);
    });

    const targetUrl = ad.link_url || (ad.design && ad.design.buttonUrl) || null;
    if (targetUrl) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => {
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      });
    }

    card.appendChild(closeBtn);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAndShowAds);
  } else {
    loadAndShowAds();
  }
})();
