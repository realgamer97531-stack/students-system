// Service worker للتطبيق اللي بيتثبت من المتصفح (PWA).
// القاعدة: النت دايمًا الأول — الكاش بيستخدم بس لما النت يقطع، فالموقع وهو أونلاين بيشتغل زي ما هو بالظبط.
// مش بنخزن أبدًا: طلبات الـ API، الملفات المرفوعة/الفيديوهات، أي طلب غير GET، ولا صفحات نظام الموظفين (فيها بيانات خاصة).
// لو حصلت أي مشكلة: غير VERSION أو خلي الملف ده فاضي من الـ fetch handler وكل الأجهزة هتاخد النسخة الجديدة.
const VERSION = 'v2';
const PAGE_CACHE = `sf-pages-${VERSION}`;
const ASSET_CACHE = `sf-assets-${VERSION}`;
const CDN_CACHE = `sf-cdn-${VERSION}`;
const KEEP = [PAGE_CACHE, ASSET_CACHE, CDN_CACHE];

const BASE = new URL('./', self.location).pathname; // "/" غالبًا
const OFFLINE_URL = `${BASE}offline.html`;

// صفحات بوابة الطالب وولي الأمر (ملفات ثابتة، البيانات بتيجي من الـ API بالتوكن) — دي بس اللي بنحتفظ بنسخة منها
const PORTAL_PAGES = new Set([
  '', 'index.html', 'student.html', 'parent.html', 'lessons.html', 'lesson-view.html',
  'homework.html', 'sessions.html', 'booklets.html', 'register.html', 'center.html',
].map((p) => BASE + p));

const PRECACHE = [
  OFFLINE_URL,
  `${BASE}icons/icon-192.png`,
  `${BASE}manifest.json`,
];

const CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com']);
const STATIC_EXT = /\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|json)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PAGE_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => {}) // لو فشل التخزين المسبق ميمنعش التثبيت
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sf-') && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function putInCache(cacheName, request, response) {
  if (!response || !(response.ok || response.type === 'opaque')) return;
  const copy = response.clone();
  caches.open(cacheName).then((cache) => cache.put(request, copy)).catch(() => {});
}

// النت الأول، ولو فشل نرجع للنسخة المحفوظة
async function networkFirst(request, cacheName, { fallbackToOffline = false } = {}) {
  try {
    const response = await fetch(request);
    if (cacheName) putInCache(cacheName, request, response);
    return response;
  } catch (err) {
    if (cacheName) {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
    }
    if (fallbackToOffline) {
      const offline = await caches.match(OFFLINE_URL);
      if (offline) return offline;
    }
    throw err;
  }
}

// ملفات الـ CDN روابطها فيها رقم الإصدار فمش بتتغير — الكاش الأول
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  putInCache(CDN_CACHE, request, response);
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return; // تشغيل الفيديو

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    if (CDN_HOSTS.has(url.hostname)) event.respondWith(cacheFirst(request));
    return; // أي سيرفر تاني (الـ API، يوتيوب، ...) مالناش دعوة بيه
  }

  if (url.pathname.startsWith(`${BASE}api/`) || url.pathname.startsWith(`${BASE}uploads/`)) return;

  if (request.mode === 'navigate') {
    // صفحات البوابة: بنحفظ نسخة. أي صفحة تانية (نظام الموظفين): من غير حفظ، بس لو النت قاطع نعرض صفحة "مفيش نت"
    const isPortalPage = PORTAL_PAGES.has(url.pathname);
    event.respondWith(networkFirst(request, isPortalPage ? PAGE_CACHE : null, { fallbackToOffline: true }));
    return;
  }

  if (STATIC_EXT.test(url.pathname) && url.pathname !== `${BASE}sw.js`) {
    event.respondWith(networkFirst(request, ASSET_CACHE));
  }
});
