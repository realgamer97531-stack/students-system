// واجهة السؤال المنبثق (Popup Question) — مشتركة بين صفحة الدرس (الطالب) ومعاينة الأدمن.
// PopupQuestionUI.mount(question, { lang, onChoice(choice) -> result, onEssay(file) -> result, onClosed() })
// - بيقفل السؤال تمامًا لحد ما الطالب يجاوب ويخلّص فيديو الحل (لو فيه).
// - كل نصوص المستخدم بتتحط بـ textContent (مفيش innerHTML لمحتوى جاي من الداتابيز).
(function () {
  const TEXT = {
    ar: {
      header: '❓ سؤال', bonus: (n) => `+${n} نقطة`, pickAnswer: 'اختار إجابتك', essayHint: 'ارفع صورة إجابتك (حل مكتوب بخط اليد)',
      chooseFile: '📷 اختر صورة', submit: 'إرسال الإجابة', sending: 'جاري الإرسال...',
      correct: (p) => `✅ إجابة صحيحة!${p ? ` حصلت على +${p} نقطة` : ''}`, wrong: '❌ إجابة خاطئة',
      essayReceived: '📨 تم استلام إجابتك. هتعرف النتيجة بعد ما المساعد يصححها، وهتظهر في صفحة الدروس.',
      watchSolution: '🎬 شاهد حل السؤال', locked: (s) => `هتقدر تقفل بعد ${s} ثانية`, lockedGeneric: 'كمّل مشاهدة الحل عشان تقدر تقفل',
      close: 'إغلاق ✔', error: 'حصلت مشكلة، حاول تاني', pickFirst: 'اختار صورة الأول',
    },
    en: {
      header: '❓ Question', bonus: (n) => `+${n} pts`, pickAnswer: 'Choose your answer', essayHint: 'Upload a photo of your written answer',
      chooseFile: '📷 Choose image', submit: 'Submit answer', sending: 'Sending...',
      correct: (p) => `✅ Correct!${p ? ` You earned +${p} points` : ''}`, wrong: '❌ Wrong answer',
      essayReceived: '📨 Answer received. You will see the result once your assistant grades it, on the lessons page.',
      watchSolution: '🎬 Watch the solution', locked: (s) => `You can close in ${s}s`, lockedGeneric: 'Finish watching the solution to close',
      close: 'Close ✔', error: 'Something went wrong, try again', pickFirst: 'Pick an image first',
    },
  };

  const STYLE_ID = 'pq-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      .pq-overlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(2,6,23,var(--pq-overlay,.7));backdrop-filter:blur(4px);animation:pqFade .25s ease}
      .pq-card{width:100%;max-width:720px;max-height:94vh;overflow:auto;background:var(--pq-bg);color:var(--pq-text);border-radius:var(--pq-radius);font-family:var(--pq-font);box-shadow:0 30px 80px -20px rgba(0,0,0,.6);border:1px solid rgba(127,127,127,.2);animation:pqPop .3s cubic-bezier(.2,.9,.3,1.2)}
      .pq-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:14px 20px;background:var(--pq-accent);color:#fff;font-weight:800;border-radius:var(--pq-radius) var(--pq-radius) 0 0}
      .pq-badge{background:rgba(255,255,255,.22);padding:4px 12px;border-radius:999px;font-size:.85em;white-space:nowrap}
      .pq-body{padding:20px}
      .pq-q{font-size:var(--pq-fs);font-weight:700;line-height:1.7;white-space:pre-wrap;word-break:break-word;margin-bottom:14px}
      .pq-img{display:block;max-width:100%;max-height:340px;margin:0 auto 16px;border-radius:12px}
      .pq-choices{display:grid;gap:10px}
      .pq-choice{display:flex;align-items:center;gap:12px;width:100%;text-align:start;padding:12px 14px;border:2px solid transparent;background:var(--pq-choice);color:var(--pq-text);border-radius:calc(var(--pq-radius) * .6);font:inherit;font-size:calc(var(--pq-fs) * .9);cursor:pointer;transition:transform .15s,border-color .15s}
      .pq-choice:hover:not(:disabled){transform:translateY(-1px);border-color:var(--pq-accent)}
      .pq-choice:disabled{cursor:default}
      .pq-choice .pq-key{flex:0 0 auto;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--pq-accent);color:#fff;font-weight:800;text-transform:uppercase}
      .pq-choice .pq-txt{white-space:pre-wrap;word-break:break-word}
      .pq-choice.pq-ok{border-color:var(--pq-correct);background:color-mix(in srgb,var(--pq-correct) 18%,var(--pq-choice))}
      .pq-choice.pq-bad{border-color:var(--pq-wrong);background:color-mix(in srgb,var(--pq-wrong) 18%,var(--pq-choice))}
      .pq-hint{font-size:.9em;opacity:.75;margin-bottom:10px}
      .pq-msg{margin-top:16px;padding:12px 14px;border-radius:12px;font-weight:700;background:var(--pq-choice)}
      .pq-msg.ok{color:var(--pq-correct)} .pq-msg.bad{color:var(--pq-wrong)}
      .pq-file{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
      .pq-btn{border:0;border-radius:999px;padding:10px 22px;font:inherit;font-weight:700;cursor:pointer;background:var(--pq-accent);color:#fff}
      .pq-btn.sec{background:var(--pq-choice);color:var(--pq-text)}
      .pq-btn:disabled{opacity:.45;cursor:not-allowed}
      .pq-preview{max-width:100%;max-height:220px;border-radius:10px;margin-top:12px;display:block}
      .pq-sol{margin-top:18px}
      .pq-sol h4{font-size:1.05em;font-weight:800;margin:0 0 10px}
      .pq-video{background:#000;border-radius:12px;overflow:hidden}
      .pq-video iframe,.pq-video video{width:100%;height:360px;border:0;display:block}
      .pq-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap}
      @media(max-width:576px){.pq-body{padding:14px}.pq-video iframe,.pq-video video{height:220px}}
      @keyframes pqFade{from{opacity:0}to{opacity:1}} @keyframes pqPop{from{transform:scale(.92);opacity:0}to{transform:none;opacity:1}}
    `;
    document.head.appendChild(st);
  }

  let ytApiPromise = null;
  function loadYT() {
    if (window.YT && window.YT.Player) return Promise.resolve(true);
    if (!ytApiPromise) {
      ytApiPromise = new Promise((resolve) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (typeof prev === 'function') prev(); resolve(true); };
        if (!document.getElementById('youtubeAPIScript')) {
          const tag = document.createElement('script');
          tag.id = 'youtubeAPIScript';
          tag.src = 'https://www.youtube.com/iframe_api';
          tag.onerror = () => resolve(false);
          document.head.appendChild(tag);
        }
        setTimeout(() => resolve(!!(window.YT && window.YT.Player)), 8000);
      });
    }
    return ytApiPromise;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function mount(q, opts) {
    injectStyle();
    opts = opts || {};
    const lang = opts.lang === 'en' ? 'en' : 'ar';
    const T = TEXT[lang];
    const d = q.design || {};

    const overlay = el('div', 'pq-overlay');
    overlay.dir = lang === 'en' ? 'ltr' : 'rtl';
    overlay.style.setProperty('--pq-overlay', String((d.overlayOpacity == null ? 70 : d.overlayOpacity) / 100));
    const card = el('div', 'pq-card');
    const vars = { '--pq-bg': d.bgColor, '--pq-text': d.textColor, '--pq-accent': d.accentColor, '--pq-choice': d.choiceBgColor,
      '--pq-correct': d.correctColor, '--pq-wrong': d.wrongColor, '--pq-radius': `${d.borderRadius == null ? 20 : d.borderRadius}px`,
      '--pq-fs': `${d.fontSize || 20}px`, '--pq-font': d.fontFamily };
    Object.keys(vars).forEach((k) => { if (vars[k]) card.style.setProperty(k, vars[k]); });
    overlay.appendChild(card);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const head = el('div', 'pq-head');
    head.appendChild(el('span', '', d.headerText || T.header));
    if (q.bonusPoints > 0) head.appendChild(el('span', 'pq-badge', '⭐ ' + T.bonus(q.bonusPoints)));
    card.appendChild(head);

    const body = el('div', 'pq-body');
    card.appendChild(body);
    body.appendChild(el('div', 'pq-q', q.text || ''));
    if (q.imageUrl) { const img = el('img', 'pq-img'); img.src = q.imageUrl; img.alt = ''; body.appendChild(img); }

    const interactive = el('div');
    body.appendChild(interactive);
    const msgBox = el('div');
    body.appendChild(msgBox);
    const solBox = el('div', 'pq-sol');
    solBox.style.display = 'none';
    body.appendChild(solBox);
    const foot = el('div', 'pq-foot');
    const lockNote = el('span', 'pq-hint');
    const closeBtn = el('button', 'pq-btn', T.close);
    closeBtn.type = 'button';
    closeBtn.disabled = true;
    foot.appendChild(lockNote);
    foot.appendChild(closeBtn);
    foot.style.display = 'none';
    body.appendChild(foot);

    let closed = false;
    let ytPlayer = null;
    const timers = [];
    function close() {
      if (closed) return;
      closed = true;
      timers.forEach(clearInterval);
      if (ytPlayer) { try { ytPlayer.destroy(); } catch (_) {} }
      document.removeEventListener('keydown', blockKeys, true);
      document.body.style.overflow = prevOverflow;
      overlay.remove();
      if (opts.onClosed) opts.onClosed();
    }
    function blockKeys(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', blockKeys, true);
    closeBtn.onclick = () => { if (!closeBtn.disabled) close(); };
    document.body.appendChild(overlay);

    function unlock() {
      closeBtn.disabled = false;
      lockNote.textContent = '';
    }

    function showSolution(sol) {
      foot.style.display = 'flex';
      if (!sol || !sol.url) { unlock(); return; }
      solBox.style.display = 'block';
      solBox.appendChild(el('h4', '', T.watchSolution));
      const holder = el('div', 'pq-video');
      solBox.appendChild(holder);
      lockNote.textContent = T.lockedGeneric;

      const start = sol.start || 0;
      const end = sol.end || 0;
      const min = sol.minSeconds || 0;
      let ended = false;
      let minPassed = min <= 0;
      const tryUnlock = () => { if (ended && minPassed) unlock(); };
      if (!minPassed) {
        const t0 = Date.now();
        const id = setInterval(() => {
          const left = min - Math.floor((Date.now() - t0) / 1000);
          if (left <= 0) { minPassed = true; clearInterval(id); tryUnlock(); }
        }, 500);
        timers.push(id);
      }
      const markEnded = () => { ended = true; tryUnlock(); };
      // fallback لأي مشغل مش قادرين نعرف منه إنه خلص: عداد بمدة الحل (أو 30 ث لو مش معروفة)
      const startCountdown = (seconds) => {
        const t0 = Date.now();
        const id = setInterval(() => {
          const left = Math.max(0, seconds - Math.floor((Date.now() - t0) / 1000));
          if (left > 0) lockNote.textContent = T.locked(left);
          else { clearInterval(id); markEnded(); }
        }, 500);
        timers.push(id);
      };

      const source = typeof detectVideoSource === 'function' ? detectVideoSource(sol.url) : { type: 'iframe', url: sol.url };
      if (source.type === 'direct') {
        const v = document.createElement('video');
        v.controls = true; v.playsInline = true; v.src = source.url;
        v.addEventListener('loadedmetadata', () => { if (start) v.currentTime = start; });
        v.addEventListener('timeupdate', () => { if (end && v.currentTime >= end) { v.pause(); markEnded(); } });
        v.addEventListener('ended', markEnded);
        holder.appendChild(v);
      } else if (source.type === 'youtube') {
        const div = el('div');
        div.id = 'pq-yt-' + Math.random().toString(36).slice(2);
        holder.appendChild(div);
        let fallbackStarted = false;
        const fallback = () => { if (fallbackStarted) return; fallbackStarted = true; startCountdown(end > start ? end - start : 30); };
        loadYT().then((ok) => {
          if (closed) return;
          if (!ok) {
            holder.textContent = '';
            const f = document.createElement('iframe');
            f.src = `https://www.youtube.com/embed/${source.id}?rel=0&start=${start}${end ? `&end=${end}` : ''}`;
            f.allow = 'autoplay; encrypted-media; picture-in-picture'; f.setAttribute('allowfullscreen', 'true');
            holder.appendChild(f);
            fallback();
            return;
          }
          const vars2 = { rel: 0, modestbranding: 1, playsinline: 1, start };
          if (end) vars2.end = end;
          ytPlayer = new YT.Player(div.id, {
            width: '100%', height: '360', videoId: source.id, playerVars: vars2,
            events: { onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED) markEnded(); }, onError: fallback },
          });
        });
      } else if (source.type === 'drive' || source.type === 'vimeo' || source.type === 'mediadelivery' || source.type === 'iframe') {
        const f = document.createElement('iframe');
        f.src = source.type === 'drive' ? `https://drive.google.com/file/d/${source.id}/preview` : source.url;
        f.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
        f.setAttribute('allowfullscreen', 'true');
        holder.appendChild(f);
        startCountdown(Math.max(min, end > start ? end - start : 30));
      } else {
        unlock();
      }
    }

    function showResult(result) {
      interactive.querySelectorAll('button,input').forEach((b) => { b.disabled = true; });
      msgBox.textContent = '';
      if (q.type === 'mcq') {
        interactive.querySelectorAll('.pq-choice').forEach((b) => {
          if (b.dataset.key === result.correctChoice) b.classList.add('pq-ok');
          else if (b.dataset.key === result.selected) b.classList.add('pq-bad');
        });
        const ok = result.isCorrect === true;
        msgBox.appendChild(el('div', 'pq-msg ' + (ok ? 'ok' : 'bad'), ok ? T.correct(result.pointsAwarded) : T.wrong));
      } else {
        msgBox.appendChild(el('div', 'pq-msg', T.essayReceived));
      }
      showSolution(result.solution);
    }

    if (q.type === 'mcq') {
      interactive.className = 'pq-choices';
      interactive.appendChild(el('div', 'pq-hint', T.pickAnswer));
      ['a', 'b', 'c', 'd'].forEach((key) => {
        const b = el('button', 'pq-choice');
        b.type = 'button';
        b.dataset.key = key;
        b.appendChild(el('span', 'pq-key', key));
        b.appendChild(el('span', 'pq-txt', (q.choices && q.choices[key]) || ''));
        b.onclick = async () => {
          interactive.querySelectorAll('button').forEach((x) => { x.disabled = true; });
          try {
            const result = await opts.onChoice(key);
            showResult(result);
          } catch (err) {
            interactive.querySelectorAll('button').forEach((x) => { x.disabled = false; });
            msgBox.textContent = '';
            msgBox.appendChild(el('div', 'pq-msg bad', T.error));
          }
        };
        interactive.appendChild(b);
      });
    } else {
      interactive.appendChild(el('div', 'pq-hint', T.essayHint));
      const row = el('div', 'pq-file');
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*'; input.style.display = 'none';
      const pick = el('button', 'pq-btn sec', T.chooseFile); pick.type = 'button';
      const send = el('button', 'pq-btn', T.submit); send.type = 'button'; send.disabled = true;
      const preview = el('img', 'pq-preview'); preview.style.display = 'none';
      pick.onclick = () => input.click();
      input.onchange = () => {
        const f = input.files && input.files[0];
        send.disabled = !f;
        if (f) { preview.src = URL.createObjectURL(f); preview.style.display = 'block'; }
      };
      send.onclick = async () => {
        const f = input.files && input.files[0];
        if (!f) { msgBox.textContent = T.pickFirst; return; }
        send.disabled = true; pick.disabled = true; send.textContent = T.sending;
        try {
          const result = await opts.onEssay(f);
          send.textContent = T.submit;
          showResult(result);
        } catch (err) {
          send.disabled = false; pick.disabled = false; send.textContent = T.submit;
          msgBox.textContent = '';
          msgBox.appendChild(el('div', 'pq-msg bad', T.error));
        }
      };
      row.appendChild(pick); row.appendChild(send); row.appendChild(input);
      interactive.appendChild(row);
      interactive.appendChild(preview);
    }

    return { close, element: overlay };
  }

  window.PopupQuestionUI = { mount };
})();
