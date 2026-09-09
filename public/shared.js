const token = localStorage.getItem('portal_token');
const portalType = localStorage.getItem('portal_type');

// Show request activity without blocking the page or changing fetch behavior.
(function installRequestIndicator() {
  if (window.__portalRequestIndicatorInstalled) return;
  window.__portalRequestIndicatorInstalled = true;

  const indicator = document.createElement('div');
  indicator.id = 'portal-request-indicator';
  indicator.setAttribute('role', 'status');
  indicator.setAttribute('aria-label', 'Loading');
  indicator.innerHTML = '<span></span>';
  indicator.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:10000',
    'width:24px', 'height:24px', 'padding:4px', 'display:none',
    'border-radius:50%', 'background:rgba(255,255,255,.92)',
    'box-shadow:0 2px 10px rgba(15,23,42,.16)', 'pointer-events:none'
  ].join(';');
  indicator.firstElementChild.style.cssText = [
    'display:block', 'width:16px', 'height:16px', 'border:2px solid #cbd5e1',
    'border-top-color:#4f46e5', 'border-radius:50%',
    'animation:portal-request-spin .7s linear infinite'
  ].join(';');
  document.head.insertAdjacentHTML('beforeend', '<style>@keyframes portal-request-spin{to{transform:rotate(360deg)}}</style>');
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(indicator), { once: true });

  const originalFetch = window.fetch.bind(window);
  let activeRequests = 0;
  let showTimer = null;

  function updateIndicator() {
    if (!indicator.isConnected) return;
    if (activeRequests > 0) {
      if (!showTimer) showTimer = setTimeout(() => {
        showTimer = null;
        indicator.style.display = 'block';
      }, 120);
    } else {
      if (showTimer) { clearTimeout(showTimer); showTimer = null; }
      indicator.style.display = 'none';
    }
  }

  window.fetch = (...args) => {
    activeRequests += 1;
    updateIndicator();
    return originalFetch(...args).finally(() => {
      activeRequests = Math.max(0, activeRequests - 1);
      updateIndicator();
    });
  };
})();

if (!token || portalType !== 'student') {
  window.location.href = 'index.html';
}

function logout() {
  localStorage.removeItem('portal_token');
  localStorage.removeItem('portal_type');
  window.location.href = 'index.html';
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

const homeworkLabels = {
  complete: '<span class="badge bg-success">كامل</span>',
  incomplete: '<span class="badge bg-warning text-dark">مش كامل</span>',
  no_steps: '<span class="badge bg-secondary">من غير خطوات</span>',
  not_done: '<span class="badge bg-danger">مش معمول</span>',
};