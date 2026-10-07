// تثبيت الموقع كتطبيق على الموبايل (PWA): تسجيل الـ service worker + زرار "ثبّت التطبيق" في القايمة + شرح للآيفون.
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
  var isPortal = !!document.querySelector('script[src*="config.js"]');

  // لما التطبيق المثبت يفتح على صفحة الدخول والطالب/ولي الأمر داخل أصلًا (والتوكن لسه صالح) نوديه على صفحته على طول
  if (isStandalone && isPortal && /\/(index\.html)?$/.test(location.pathname)) {
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

  if (isStandalone) return; // التطبيق متثبت ومفتوح كتطبيق — مفيش داعي لأي زرار تثبيت

  // التثبيت للموبايل والتابلت بس
  var isPhone = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (!isPhone) return;

  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // متصفحات جوه تطبيقات (فيسبوك/انستجرام/تيك توك/سناب...) مش بتقدر تثبت خالص
  var isInAppBrowser = /FBAN|FBAV|FB_IAB|Instagram|Snapchat|TikTok|musical_ly|BytedanceWebview|Line\/|Twitter|LinkedInApp|GSA\//i.test(ua);
  var isIOSSafari = isIOS && !isInAppBrowser && !/CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|DuckDuckGo/i.test(ua);
  var isSamsung = /SamsungBrowser/i.test(ua);

  function lang() {
    if (isPortal) return store('portal_lang') === 'en' ? 'en' : 'ar';
    return document.documentElement.getAttribute('lang') === 'en' ? 'en' : 'ar';
  }

  var SHARE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-4px"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
  var PLUS_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#181527" stroke-width="2" stroke-linecap="round" style="vertical-align:-4px"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
  var DOTS_V = '<b style="font-size:1.1rem">⋮</b>';

  var T = {
    ar: {
      menuIOS: '📲 أضف التطبيق للآيفون',
      menuAndroid: '📲 تثبيت التطبيق',
      menuShort: '📲 التطبيق',
      bannerTitle: 'ثبّت التطبيق على موبايلك',
      bannerBody: 'افتح المنصة من أيقونة على الشاشة الرئيسية بسرعة ومن غير المتصفح.',
      bannerBodyIOS: 'ضيف المنصة كتطبيق على الشاشة الرئيسية في خطوتين.',
      install: 'تثبيت',
      how: 'إزاي؟',
      later: 'لاحقًا',
      close: 'تمام',
      guideTitle: 'إضافة التطبيق للشاشة الرئيسية',
      iosSteps: [
        'اضغط على زرار <b>المشاركة</b> ' + SHARE_ICON + ' في شريط Safari (تحت في الآيفون — ولو مش ظاهر اضغط <b>•••</b> الأول).',
        'انزل في القائمة واضغط <b>"إضافة إلى الشاشة الرئيسية"</b> ' + PLUS_ICON + ' (لو مش لاقيها اضغط <b>"عرض المزيد"</b>).',
        'خلي <b>"فتح كتطبيق ويب"</b> شغال لو ظاهر، وبعدين اضغط <b>"إضافة"</b>. هتلاقي أيقونة التطبيق على الشاشة الرئيسية.',
      ],
      iosOtherBrowser: 'في Chrome على الآيفون: اضغط زرار المشاركة ' + SHARE_ICON + ' جنب العنوان فوق، وبعدين <b>"إضافة إلى الشاشة الرئيسية"</b>. لو مش ظاهر، انسخ الرابط وافتحه من <b>Safari</b>.',
      inApp: 'إنت فاتح الموقع من جوه تطبيق (فيسبوك/انستجرام/...) ومينفعش التثبيت من هنا. اضغط <b>•••</b> واختار <b>"فتح في المتصفح"</b> (Safari أو Chrome) — أو انسخ الرابط وافتحه هناك.',
      androidSteps: [
        'اضغط على قائمة المتصفح ' + DOTS_V + ' فوق.',
        'اختار <b>"تثبيت التطبيق"</b> أو <b>"إضافة إلى الشاشة الرئيسية"</b>.',
        'اضغط <b>"تثبيت"</b> — هتلاقي أيقونة التطبيق على الشاشة الرئيسية.',
      ],
      samsungSteps: [
        'اضغط على القائمة <b>☰</b> تحت.',
        'اختار <b>"إضافة صفحة إلى"</b> ← <b>"الشاشة الرئيسية"</b>.',
        'اضغط <b>"إضافة"</b>.',
      ],
      copy: '📋 نسخ الرابط',
      copied: '✅ تم النسخ',
      share: '📤 شارك التطبيق مع صاحبك',
      shareText: 'حمّل تطبيق المنصة على موبايلك',
    },
    en: {
      menuIOS: '📲 Add app to iPhone',
      menuAndroid: '📲 Install app',
      menuShort: '📲 App',
      bannerTitle: 'Install the app on your phone',
      bannerBody: 'Open the platform from a home-screen icon — faster, without the browser.',
      bannerBodyIOS: 'Add the platform to your home screen in two steps.',
      install: 'Install',
      how: 'How?',
      later: 'Later',
      close: 'Got it',
      guideTitle: 'Add the app to your home screen',
      iosSteps: [
        'Tap the <b>Share</b> button ' + SHARE_ICON + ' in the Safari bar (at the bottom on iPhone — if you don\'t see it, tap <b>•••</b> first).',
        'Scroll down and tap <b>"Add to Home Screen"</b> ' + PLUS_ICON + ' (tap <b>"View More"</b> if it\'s hidden).',
        'Keep <b>"Open as Web App"</b> on if shown, then tap <b>"Add"</b>. The app icon appears on your home screen.',
      ],
      iosOtherBrowser: 'In Chrome on iPhone: tap the Share button ' + SHARE_ICON + ' next to the address bar, then <b>"Add to Home Screen"</b>. If it\'s missing, copy the link and open it in <b>Safari</b>.',
      inApp: 'You opened the site inside another app (Facebook/Instagram/...), which can\'t install apps. Tap <b>•••</b> and choose <b>"Open in browser"</b> (Safari or Chrome) — or copy the link and open it there.',
      androidSteps: [
        'Tap the browser menu ' + DOTS_V + ' at the top.',
        'Choose <b>"Install app"</b> or <b>"Add to Home screen"</b>.',
        'Tap <b>"Install"</b> — the app icon appears on your home screen.',
      ],
      samsungSteps: [
        'Tap the menu <b>☰</b> at the bottom.',
        'Choose <b>"Add page to"</b> → <b>"Home screen"</b>.',
        'Tap <b>"Add"</b>.',
      ],
      copy: '📋 Copy link',
      copied: '✅ Copied',
      share: '📤 Share the app with a friend',
      shareText: 'Get the platform app on your phone',
    },
  };

  var deferredPrompt = null;
  var banner = null;
  var DISMISS_KEY = 'pwa_install_dismissed_until';

  // الرابط اللي بيتنسخ/يتشارك: صفحة دخول البوابة أو صفحة دخول الموظفين
  function appUrl() { return isPortal ? base : location.origin + '/login'; }

  // أندرويد: نافذة التثبيت على طول لو المتصفح جاهز، غير كده (وفي الآيفون دايمًا) = شرح الخطوات
  function onInstallTap(e) {
    if (e) e.preventDefault();
    // نقفل القائمة الجانبية (Bootstrap offcanvas) الأول عشان متمسكش الفوكس من الشرح
    var sidebar = document.getElementById('mobileSidebar');
    if (sidebar && window.bootstrap && window.bootstrap.Offcanvas) {
      var oc = window.bootstrap.Offcanvas.getInstance(sidebar);
      if (oc) oc.hide();
    }
    if (document.getElementById('sidebar') && typeof window.toggleSidebar === 'function' && document.getElementById('sidebar').classList.contains('open')) {
      window.toggleSidebar();
    }
    if (deferredPrompt && !isIOS) {
      var p = deferredPrompt;
      deferredPrompt = null;
      p.prompt();
      p.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') dismissBanner(365);
      });
      return;
    }
    openGuide();
  }

  function steps(list) {
    return '<ol style="padding:0;margin:0;list-style:none">' + list.map(function (s, i) {
      return '<li style="display:flex;gap:10px;align-items:flex-start;margin-bottom:12px;line-height:1.7">'
        + '<span style="flex:none;width:26px;height:26px;border-radius:50%;background:#4338CA;color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:.85rem">' + (i + 1) + '</span>'
        + '<span>' + s + '</span></li>';
    }).join('') + '</ol>';
  }

  function openGuide() {
    var t = T[lang()];
    var old = document.getElementById('pwa-guide');
    if (old) old.remove();
    var needsCopy = isInAppBrowser || (isIOS && !isIOSSafari);
    var body;
    if (isInAppBrowser) body = '<p style="line-height:1.8;margin:0">' + t.inApp + '</p>';
    else if (isIOS && !isIOSSafari) body = '<p style="line-height:1.8;margin:0">' + t.iosOtherBrowser + '</p>';
    else if (isIOS) body = steps(t.iosSteps);
    else body = steps(isSamsung ? t.samsungSteps : t.androidSteps);

    var overlay = document.createElement('div');
    overlay.id = 'pwa-guide';
    overlay.setAttribute('dir', lang() === 'ar' ? 'rtl' : 'ltr');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483001;background:rgba(15,23,42,.55);display:flex;align-items:flex-end;justify-content:center;padding:12px;font-family:Cairo,Tahoma,sans-serif;text-align:start';
    var btn = 'display:block;width:100%;border-radius:11px;padding:11px;font:inherit;font-weight:700;font-size:.92rem;margin-top:8px;cursor:pointer;';
    overlay.innerHTML =
      '<div style="background:#fff;color:#181527;border-radius:18px;padding:20px 18px calc(16px + env(safe-area-inset-bottom,0px));width:100%;max-width:440px;max-height:90vh;overflow:auto;box-shadow:0 -10px 40px rgba(0,0,0,.25)">'
      + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">'
      + '<img src="' + base + 'icons/icon-192.png" alt="" style="width:44px;height:44px;border-radius:11px">'
      + '<div style="font-weight:800;font-size:1.05rem">' + t.guideTitle + '</div></div>'
      + '<div style="font-size:.92rem">' + body + '</div>'
      + (needsCopy ? '<button type="button" data-g="copy" style="' + btn + 'background:#EEF0FB;color:#4338CA;border:0">' + t.copy + '</button>' : '')
      + '<button type="button" data-g="share" style="' + btn + 'background:#fff;color:#4338CA;border:1.5px solid #c7c9f0">' + t.share + '</button>'
      + '<button type="button" data-g="close" style="' + btn + 'background:#4338CA;color:#fff;border:0">' + t.close + '</button>'
      + '</div>';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { overlay.remove(); return; }
      var b = e.target.closest && e.target.closest('[data-g]');
      if (!b) return;
      var action = b.getAttribute('data-g');
      if (action === 'close') overlay.remove();
      if (action === 'copy') copyLink(b, t);
      if (action === 'share') {
        if (navigator.share) navigator.share({ title: document.title, text: t.shareText, url: appUrl() }).catch(function () {});
        else copyLink(b, t);
      }
    });
    document.body.appendChild(overlay);
  }

  function copyLink(button, t) {
    var url = appUrl();
    var done = function () { button.textContent = t.copied; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { window.prompt('', url); });
    } else {
      window.prompt('', url);
    }
  }

  // ===== عنصر "تثبيت التطبيق" في القوايم =====
  function itemLabel(kind, l) {
    var t = T[l || lang()];
    if (kind === 'short') return t.menuShort;
    return isIOS ? t.menuIOS : t.menuAndroid;
  }

  function makeButton(className, kind) {
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'nav-install-app';
    b.className = className;
    b.setAttribute('data-kind', kind);
    b.textContent = itemLabel(kind);
    b.addEventListener('click', onInstallTap);
    return b;
  }

  function addMenuItems() {
    if (document.getElementById('nav-install-app')) return;
    // بوابة الطالب: القائمة الجانبية، قبل زرار الخروج
    var studentLogout = document.querySelector('#mobileSidebar #nav-logout');
    if (studentLogout) {
      var sb = makeButton('btn btn-outline-light w-100 w-md-auto text-start text-md-center', 'full');
      sb.style.cssText = 'border-style:dashed;font-weight:700';
      studentLogout.parentNode.insertBefore(sb, studentLogout);
      return;
    }
    // صفحة ولي الأمر: زرار صغير في الشريط اللي فوق جنب الخروج
    var parentLogout = isPortal && document.getElementById('btn-logout');
    if (parentLogout) {
      parentLogout.parentNode.insertBefore(makeButton('btn btn-sm btn-light fw-bold', 'short'), parentLogout);
      return;
    }
    // نظام الموظفين: السايد بار، قبل تسجيل الخروج (العربي/الإنجليزي بيتبدلوا بالـ CSS بتاع الصفحة)
    var staffLogout = document.querySelector('#sidebar a[href="/logout"]');
    if (staffLogout) {
      var a = document.createElement('a');
      a.href = '#';
      a.id = 'nav-install-app';
      a.innerHTML = '<span class="ar-only">' + itemLabel('full', 'ar') + '</span>'
        + '<span class="en-only" style="display:none;">' + itemLabel('full', 'en') + '</span>';
      a.addEventListener('click', onInstallTap);
      staffLogout.parentNode.insertBefore(a, staffLogout);
    }
  }

  // البوابة بتغير اللغة من غير ريلود — نحدث كلام الزرار
  document.addEventListener('click', function (e) {
    if (!e.target || e.target.id !== 'lang-toggle-btn') return;
    setTimeout(function () {
      var item = document.getElementById('nav-install-app');
      if (item && item.tagName === 'BUTTON') item.textContent = itemLabel(item.getAttribute('data-kind'));
    }, 50);
  });

  // ===== الشريط اللي تحت (بيختفي أسبوع لو داس "لاحقًا") =====
  function dismissBanner(days) {
    store(DISMISS_KEY, String(Date.now() + days * 24 * 60 * 60 * 1000));
    if (banner) banner.remove();
    banner = null;
  }

  function showBanner() {
    if (banner || !document.body) return;
    if (Number(store(DISMISS_KEY) || 0) > Date.now()) return;
    var t = T[lang()];
    var guideMode = isIOS || !deferredPrompt;
    banner = document.createElement('div');
    banner.setAttribute('dir', lang() === 'ar' ? 'rtl' : 'ltr');
    banner.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483000;'
      + 'background:#fff;color:#181527;border-radius:16px;box-shadow:0 12px 32px rgba(30,27,75,.25);padding:14px;'
      + 'display:flex;gap:12px;align-items:center;font-family:Cairo,Tahoma,sans-serif;max-width:480px;margin:0 auto;';
    banner.innerHTML =
      '<img src="' + base + 'icons/icon-192.png" alt="" style="width:46px;height:46px;border-radius:12px;flex:none">'
      + '<div style="flex:1;min-width:0">'
      + '<div style="font-weight:800;font-size:.95rem">' + t.bannerTitle + '</div>'
      + '<div style="font-size:.8rem;color:#6B7280;line-height:1.5;margin-top:2px">' + (guideMode ? t.bannerBodyIOS : t.bannerBody) + '</div>'
      + '</div>'
      + '<div style="display:flex;flex-direction:column;gap:6px;flex:none">'
      + '<button type="button" data-pwa="install" style="background:#4338CA;color:#fff;border:0;border-radius:10px;padding:8px 16px;font:inherit;font-weight:700;font-size:.85rem">' + (guideMode ? t.how : t.install) + '</button>'
      + '<button type="button" data-pwa="later" style="background:transparent;color:#6B7280;border:0;padding:4px;font:inherit;font-size:.8rem">' + t.later + '</button>'
      + '</div>';
    banner.addEventListener('click', function (e) {
      var action = e.target && e.target.getAttribute('data-pwa');
      if (action === 'later') dismissBanner(7);
      if (action === 'install') {
        banner.remove();
        banner = null;
        onInstallTap();
      }
    });
    document.body.appendChild(banner);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    setTimeout(showBanner, 1500);
  });

  window.addEventListener('appinstalled', function () {
    dismissBanner(365);
    var item = document.getElementById('nav-install-app');
    if (item) item.remove();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addMenuItems);
  else addMenuItems();
  if (isIOS) window.addEventListener('load', function () { setTimeout(showBanner, 2500); });
})();
