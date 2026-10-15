// حفظ مؤقت للي بتكتبه في فورمز نظام الموظفين (في المتصفح بس — localStorage)،
// عشان لو الصفحة اتحدثت أو السيرفر عمل ديبلوي/ريستارت وانت شغال، ترجع تلاقي اللي كتبته زي ما هو.
// - بيحفظ بس الخانات اللي انت غيرتها بإيدك، وجوه فورمز POST بس (فورمز البحث/الفلترة بتتحفظ في اللينك أصلًا).
// - مش بيحفظ أبدًا: الباسوردات، الملفات، الخانات المخفية، أو أي حاجة جوه عنصر عليه data-no-draft.
// - لما تبعت الفورم المسودة بتتمسح، والمسودات القديمة (أكتر من 12 ساعة) بتتمسح لوحدها.
// - الاسترجاع مش بيشغل أي أحداث change (عشان ميبعتش فورم أو يفتح صفحة لوحده) وفيه زرار "تراجع".
(function () {
  if (/^\/login/.test(location.pathname)) return;

  var PREFIX = 'sf_draft:';
  var MAX_AGE_MS = 12 * 60 * 60 * 1000;
  var SKIP_TYPES = /^(password|file|hidden|submit|button|reset|image)$/i;

  function ls(action, key, value) {
    try {
      if (action === 'get') return localStorage.getItem(key);
      if (action === 'set') localStorage.setItem(key, value);
      if (action === 'del') localStorage.removeItem(key);
    } catch (e) { /* التخزين مقفول (وضع خاص مثلًا) — منعملش حاجة */ }
    return null;
  }

  function isEnglish() { return ls('get', 'language') === 'en'; }

  function draftForm(el) {
    var form = el && el.form;
    if (!form || form.hasAttribute('data-no-draft')) return null;
    if (String(form.getAttribute('method') || 'get').toLowerCase() !== 'post') return null;
    return form;
  }

  function fieldName(el) { return el.name || el.id || ''; }

  function trackable(el) {
    if (!el || !el.tagName || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
    if (el.tagName === 'INPUT' && SKIP_TYPES.test(el.type || '')) return false;
    if (el.disabled || !fieldName(el)) return false;
    if (el.closest && el.closest('[data-no-draft]')) return false;
    if (/pass|token|secret|otp/i.test(fieldName(el))) return false;
    return !!draftForm(el);
  }

  function formKey(form) {
    var forms = Array.prototype.slice.call(document.querySelectorAll('form'));
    var id = form.id || form.getAttribute('action') || ('#' + forms.indexOf(form));
    return PREFIX + location.pathname + location.search + '|' + id;
  }

  function radioOrBoxKey(el) {
    return (el.type === 'radio' || el.type === 'checkbox') ? fieldName(el) + '=' + el.value : fieldName(el);
  }

  function readValue(el) {
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
    if (el.tagName === 'SELECT' && el.multiple) {
      return Array.prototype.filter.call(el.options, function (o) { return o.selected; }).map(function (o) { return o.value; });
    }
    return el.value;
  }

  function load(key) {
    try { return JSON.parse(ls('get', key) || 'null'); } catch (e) { return null; }
  }

  // ===== الحفظ =====
  var pending = {};
  var timer = null;

  function remember(el) {
    if (!trackable(el)) return;
    var key = formKey(draftForm(el));
    var entry = pending[key] || load(key) || { fields: {} };
    delete entry.submittedAt;
    entry.t = Date.now();
    entry.fields[radioOrBoxKey(el)] = readValue(el);
    pending[key] = entry;
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  }

  function flush() {
    Object.keys(pending).forEach(function (key) { ls('set', key, JSON.stringify(pending[key])); });
    pending = {};
  }

  document.addEventListener('input', function (e) { remember(e.target); }, true);
  document.addEventListener('change', function (e) { if (e.isTrusted) remember(e.target); }, true);
  window.addEventListener('pagehide', flush);

  // بعد الإرسال: بنعلم المسودة إنها اتبعتت. لو الصفحة اتحدثت (Reload) على طول بنرجعها
  // (عشان لو السيرفر كان واقع وقت الإرسال)، وأي فتح عادي للصفحة بعد كده بيمسحها.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    flush();
    var key = formKey(form);
    var entry = load(key);
    if (!entry) return;
    entry.submittedAt = Date.now();
    ls('set', key, JSON.stringify(entry));
  });
  document.addEventListener('reset', function (e) {
    if (e.target && e.target.tagName === 'FORM') { flush(); ls('del', formKey(e.target)); }
  }, true);

  // ===== الاسترجاع =====
  function navigationType() {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav) return nav.type;
    } catch (e) { /* متصفح قديم */ }
    return (performance.navigation && performance.navigation.type === 1) ? 'reload' : 'navigate';
  }

  function pruneOld() {
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var key = localStorage.key(i);
        if (!key || key.indexOf(PREFIX) !== 0) continue;
        var entry = load(key);
        if (!entry || !entry.t || Date.now() - entry.t > MAX_AGE_MS) ls('del', key);
      }
    } catch (e) { /* مفيش تخزين */ }
  }

  function fieldsOf(form, name) {
    return Array.prototype.filter.call(form.elements, function (el) { return fieldName(el) === name; });
  }

  function apply(form, storedKey, value, undo) {
    var eq = storedKey.indexOf('=');
    var isChoice = typeof value === 'boolean';
    var name = isChoice && eq > 0 ? storedKey.slice(0, eq) : storedKey;
    var choiceValue = isChoice && eq > 0 ? storedKey.slice(eq + 1) : null;
    fieldsOf(form, name).forEach(function (el) {
      if (!trackable(el)) return;
      if (isChoice) {
        if ((el.type !== 'checkbox' && el.type !== 'radio') || el.value !== choiceValue || el.checked === value) return;
        undo.push({ el: el, checked: el.checked });
        el.checked = value;
      } else if (el.tagName === 'SELECT' && Array.isArray(value)) {
        undo.push({ el: el, selected: readValue(el) });
        Array.prototype.forEach.call(el.options, function (o) { o.selected = value.indexOf(o.value) !== -1; });
      } else if (el.type !== 'checkbox' && el.type !== 'radio') {
        if (el.value === value) return;
        if (el.tagName === 'SELECT' && !Array.prototype.some.call(el.options, function (o) { return o.value === value; })) return;
        undo.push({ el: el, value: el.value });
        el.value = value;
      } else {
        return;
      }
      refreshWidget(el);
    });
  }

  // Select2 بس بيحدث شكله، من غير ما يشغل أي كود تاني مربوط بالتغيير
  function refreshWidget(el) {
    if (el.tagName === 'SELECT' && window.jQuery && window.jQuery(el).data('select2')) {
      window.jQuery(el).trigger('change.select2');
    }
  }

  function restore() {
    pruneOld();
    var reloaded = navigationType() === 'reload';
    var undo = [];
    var restoredKeys = [];
    Array.prototype.forEach.call(document.querySelectorAll('form'), function (form) {
      if (form.hasAttribute('data-no-draft')) return;
      if (String(form.getAttribute('method') || 'get').toLowerCase() !== 'post') return;
      var key = formKey(form);
      var entry = load(key);
      if (!entry || !entry.fields) return;
      if (entry.submittedAt && !reloaded) { ls('del', key); return; }
      var before = undo.length;
      Object.keys(entry.fields).forEach(function (name) { apply(form, name, entry.fields[name], undo); });
      if (undo.length > before) restoredKeys.push(key);
    });
    if (undo.length) showToast(undo, restoredKeys);
  }

  function showToast(undo, keys) {
    var en = isEnglish();
    var box = document.createElement('div');
    box.setAttribute('dir', en ? 'ltr' : 'rtl');
    box.setAttribute('data-no-draft', '');
    box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:2147483000;'
      + 'background:#1E1B4B;color:#fff;border-radius:12px;padding:10px 14px;display:flex;gap:12px;align-items:center;'
      + 'box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:Cairo,Tahoma,sans-serif;font-size:.9rem;max-width:calc(100% - 32px)';
    box.innerHTML = '<span>' + (en ? 'We brought back what you were typing before the page refreshed.' : 'رجّعنالك اللي كنت كاتبه قبل ما الصفحة تتحدث.') + '</span>'
      + '<button type="button" data-d="undo" style="background:transparent;color:#99F6E4;border:1px solid #99F6E4;border-radius:8px;padding:4px 10px;font:inherit;cursor:pointer;flex:none">' + (en ? 'Undo' : 'تراجع') + '</button>'
      + '<button type="button" data-d="ok" style="background:transparent;color:#fff;border:0;font:inherit;cursor:pointer;flex:none" aria-label="close">✕</button>';
    box.addEventListener('click', function (e) {
      var action = e.target && e.target.getAttribute('data-d');
      if (!action) return;
      if (action === 'undo') {
        undo.reverse().forEach(function (u) {
          if ('checked' in u) u.el.checked = u.checked;
          else if ('selected' in u) Array.prototype.forEach.call(u.el.options, function (o) { o.selected = u.selected.indexOf(o.value) !== -1; });
          else u.el.value = u.value;
          refreshWidget(u.el);
        });
        keys.forEach(function (key) { ls('del', key); });
      }
      box.remove();
    });
    document.body.appendChild(box);
    setTimeout(function () { if (box.parentNode) box.remove(); }, 12000);
  }

  // بعد ما الصفحة تخلص تحميل (عشان Select2 والقوايم اللي بتتملي بالجافاسكريبت تكون جاهزة)
  if (document.readyState === 'complete') setTimeout(restore, 0);
  else window.addEventListener('load', function () { setTimeout(restore, 0); });
})();
