// عرض نص أسئلة اختبار المنصة: نص عادي + معادلات LaTeX بين \( \) (في السطر) أو \[ \] (سطر لوحدها).
// مستخدم في صفحة الطالب quiz.html وفي صفحة عمل الاختبار عند المساعد (المعاينة). محتاج KaTeX محمّل قبله.
(function (global) {
  var MATH_RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // بيقسم النص لأجزاء: { type: 'text', value } أو { type: 'math', value, display, index }
  function segments(text) {
    var out = [];
    var src = String(text || '');
    var last = 0;
    var index = 0;
    var match;
    MATH_RE.lastIndex = 0;
    while ((match = MATH_RE.exec(src))) {
      if (match.index > last) out.push({ type: 'text', value: src.slice(last, match.index) });
      var display = match[2] !== undefined;
      out.push({ type: 'math', value: display ? match[2] : match[1], display: display, index: index, start: match.index, end: MATH_RE.lastIndex });
      index += 1;
      last = MATH_RE.lastIndex;
    }
    if (last < src.length) out.push({ type: 'text', value: src.slice(last) });
    return out;
  }

  function renderMath(latex, display) {
    latex = String(latex).replace(/\\placeholder(\[[^\]]*\])?\{[^{}]*\}/g, '');
    if (global.katex && typeof global.katex.renderToString === 'function') {
      try {
        return global.katex.renderToString(latex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'html' });
      } catch (_) { /* بنرجع النص زي ما هو */ }
    }
    return '<code dir="ltr">' + escapeHtml(latex) + '</code>';
  }

  // options.editable: كل معادلة بتاخد data-math-index عشان المساعد يدوس عليها ويعدلها
  function html(text, options) {
    var editable = options && options.editable;
    return segments(text).map(function (part) {
      if (part.type === 'text') return escapeHtml(part.value).replace(/\n/g, '<br>');
      var tag = part.display ? 'div' : 'span';
      return '<' + tag + ' class="qz-math' + (part.display ? ' qz-math-block' : '') + '" dir="ltr"' +
        (editable ? ' data-math-index="' + part.index + '" title="دوس عشان تعدل المعادلة"' : '') + '>' +
        renderMath(part.value, part.display) + '</' + tag + '>';
    }).join('');
  }

  // بيبدل المعادلة رقم index بمعادلة جديدة (أو بيمسحها لو latex فاضي)
  function replaceMath(text, index, latex, display) {
    var parts = segments(text);
    var hit = parts.filter(function (p) { return p.type === 'math' && p.index === index; })[0];
    if (!hit) return text;
    var replacement = latex ? (display ? '\\[' + latex + '\\]' : '\\(' + latex + '\\)') : '';
    return String(text).slice(0, hit.start) + replacement + String(text).slice(hit.end);
  }

  function mathAt(text, index) {
    return segments(text).filter(function (p) { return p.type === 'math' && p.index === index; })[0] || null;
  }

  global.QuizRender = { html: html, segments: segments, replaceMath: replaceMath, mathAt: mathAt, escapeHtml: escapeHtml };
})(typeof window !== 'undefined' ? window : this);
