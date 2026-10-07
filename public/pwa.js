// تثبيت الموقع كتطبيق على الموبايل (PWA): تسجيل الـ service worker + زرار "ثبّت التطبيق".
// مش بيشتغل جوه تطبيق الموبايل (WebView) ولا برنامج الديسكتوب (Electron) — هناك هو أصلًا تطبيق.
(function () {
  var ua = navigator.userAgent || '';
  if (/Electron/i.test(ua) || /; wv\)/.test(ua)) return;
  if (!('serviceWorker' in navigator)) return;

  var scriptSrc = (document.currentScript && document.currentScript.src) || '';
  var base = scriptSrc ? scriptSrc.replace(/[^/]*$/, '') : '/';

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { return null; }
    return null;
  }

  var isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  // لما التطبيق المثبت يفتح على صفحة الدخول والطالب/ولي الأمر داخل أصلًا (والتوكن لسه صالح) نوديه على صفحته على طول
  if (isStandalone && /\/(index\.html)?$/.test(location.pathname) && document.querySelector('script[src*="config.js"]')) {
    var token = store('portal_token');
    var type = store('portal_type');
    var target = type === 'student' ? 'lessons.html' : (type === 'parent' ? 'parent.html' : null);
    if (token && target && tokenStillValid(token)) {
      location.replace(target);
      return;
    }
  }

  function tokenStillValid(jwt) {
    try {
      var payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return !payload.exp || payload.exp * 1000 > Date.now() + 60 * 1000;
    } catch (e) { return false; }
  }

  window.addEventListener('load', function () {
    navigator.serviceWorker.register(base + 'sw.js', { scope: base, updateViaCache: 'none' }).catch(function () {});
  });

  if (isStandalone) return;

  // ===== زرار التثبيت (للموبايل بس) =====
  var isPhone = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (!isPhone) return;

  var DISMISS_KEY = 'pwa_install_dismissed_until';
  var dismissedUntil = Number(store(DISMISS_KEY) || 0);
  if (dismissedUntil > Date.now()) return;

  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isIOSSafari = isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  var lang = store('portal_lang') === 'en' ? 'en' : 'ar';
  var t = {
    ar: {
      title: 'ثبّت التطبيق على موبايلك',
      body: 'افتح المنصة من أيقونة على الشاشة الرئيسية بسرعة ومن غير المتصفح.',
      install: 'تثبيت',
      later: 'لاحقًا',
      ios: 'اضغط على زرار المشاركة <b>⬆︎</b> تحت، وبعدين <b>"إضافة إلى الشاشة الرئيسية"</b>.',
    },
    en: {
      title: 'Install the app on your phone',
      body: 'Open the platform from a home-screen icon — faster, without the browser.',
      install: 'Install',
      later: 'Later',
      ios: 'Tap the Share button <b>⬆︎</b> below, then <b>"Add to Home Screen"</b>.',
    },
  }[lang];

  var deferredPrompt = null;
  var banner = null;

  function dismiss(days) {
    store(DISMISS_KEY, String(Date.now() + days * 24 * 60 * 60 * 1000));
    if (banner) banner.remove();
    banner = null;
  }

  function showBanner(iosMode) {
    if (banner || !document.body) return;
    banner = document.createElement('div');
    banner.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    banner.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483000;'
      + 'background:#fff;color:#181527;border-radius:16px;box-shadow:0 12px 32px rgba(30,27,75,.25);padding:14px;'
      + 'display:flex;gap:12px;align-items:center;font-family:Cairo,Tahoma,sans-serif;max-width:480px;margin:0 auto;';
    banner.innerHTML =
      '<img src="' + base + 'icons/icon-192.png" alt="" style="width:46px;height:46px;border-radius:12px;flex:none">'
      + '<div style="flex:1;min-width:0">'
      + '<div style="font-weight:800;font-size:.95rem">' + t.title + '</div>'
      + '<div style="font-size:.8rem;color:#6B7280;line-height:1.5;margin-top:2px">' + (iosMode ? t.ios : t.body) + '</div>'
      + '</div>'
      + '<div style="display:flex;flex-direction:column;gap:6px;flex:none">'
      + (iosMode ? '' : '<button type="button" data-pwa="install" style="background:#4338CA;color:#fff;border:0;border-radius:10px;padding:8px 16px;font:inherit;font-weight:700;font-size:.85rem">' + t.install + '</button>')
      + '<button type="button" data-pwa="later" style="background:transparent;color:#6B7280;border:0;padding:4px;font:inherit;font-size:.8rem">' + t.later + '</button>'
      + '</div>';
    banner.addEventListener('click', function (e) {
      var action = e.target && e.target.getAttribute('data-pwa');
      if (action === 'later') dismiss(7);
      if (action === 'install' && deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function (choice) {
          dismiss(choice && choice.outcome === 'accepted' ? 365 : 7);
        });
        deferredPrompt = null;
      }
    });
    document.body.appendChild(banner);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    setTimeout(function () { showBanner(false); }, 1500);
  });

  window.addEventListener('appinstalled', function () { dismiss(365); });

  if (isIOSSafari) {
    window.addEventListener('load', function () { setTimeout(function () { showBanner(true); }, 2500); });
  }
})();
