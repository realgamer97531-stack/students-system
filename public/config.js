// API server for the student portal.
// Keep this value without a trailing slash so "/api/..." paths do not become "//api/...".
const RAW_API_BASE_URL = 'https://students-system-production-6b89.up.railway.app';
const API_BASE_URL = RAW_API_BASE_URL.replace(/\/+$/, '');
// const API_BASE_URL = 'https://students-system-production-6b89.up.railway.app'; // السيرفر بتاعك
const PLATFORM_NAME = 'Shady Elsharkawy';
const PLATFORM_DOMAIN = 'shadyelsharkawy.com';
const PLATFORM_BASE_URL = (() => {
  if (typeof window === 'undefined') return '.';
  if (window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return '.';
  }
  const currentDir = window.location.pathname.replace(/\/[^/]*$/, '');
  return window.location.origin + currentDir;
})();
const CONFIG = {
    SUPPORT_PHONE: "201000733148", // without +
    SUPPORT_TEXT: "Hello, I need help."
};


const FRIENDLY_PATH_REDIRECTS = {
  '/student': '/student.html',
  '/sessions': '/sessions.html',
  '/homework': '/homework.html',
  '/lessons': '/lessons.html',
  '/booklets': '/booklets.html',
  '/parent': '/parent.html',
  '/index': '/index.html',
};

function redirectFriendlyPaths() {
  const target = FRIENDLY_PATH_REDIRECTS[window.location.pathname];
  if (target && window.location.pathname !== target) {
    window.location.replace(target + window.location.search + window.location.hash);
  }
}

function hydratePlatformBranding() {
  document.querySelectorAll('[data-platform-brand]').forEach(el => {
    el.textContent = PLATFORM_NAME;
  });
  document.querySelectorAll('[data-platform-domain]').forEach(el => {
    el.textContent = PLATFORM_DOMAIN;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  redirectFriendlyPaths();
  hydratePlatformBranding();
});
