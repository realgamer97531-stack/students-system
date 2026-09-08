import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';

const DISPOSITIONS = [
  { key: 'no_answer',    label: 'No answer' },
  { key: 'busy',         label: 'Busy' },
  { key: 'wrong_number', label: 'Wrong number' },
  { key: 'follow_up',    label: 'Follow up' },
  { key: 'rejected',     label: 'Rejected' },
  { key: 'deal_done',    label: 'Deal is done', wide: true },
];

/**
 * Convert a stored phone number to a wa.me-ready number (digits only, with
 * Egypt country code 20 prepended).
 *
 * Stored format after Excel import is always local with leading 0:
 *   01282890717  →  201282890717
 *   1282890717   →  201282890717   (shouldn't happen after import fix, but safe)
 *   +201282890717 → 201282890717
 */
function toWhatsAppNumber(phone) {
  const s = String(phone || '').trim();
  if (!s) return '';
  // Strip everything except digits
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  // Already full international (starts with 20 and long enough)
  if (digits.startsWith('20') && digits.length >= 12) return digits;
  // Local with leading 0  →  drop the 0, prepend 20
  if (digits.startsWith('0')) return '20' + digits.slice(1);
  // Bare number starting with 1 (local without leading 0)
  return '20' + digits;
}

function digitsOnly(phone) {
  return (phone || '').replace(/[^\d+]/g, '');
}

function copyText(value) {
  const text = value || '';
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const el = document.createElement('textarea');
  el.value = text;
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  el.focus();
  el.select();
  try { document.execCommand('copy'); } finally { document.body.removeChild(el); }
  return Promise.resolve();
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-btn"
      title="Copy"
      onClick={() => {
        copyText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

/* ── Session picker ───────────────────────────────────────────────── */

function SessionPicker({ onPick }) {
  const [sessions, setSessions] = useState([]);
  const [error, setError]       = useState('');

  useEffect(() => {
    api.listSessions()
      .then((s) => setSessions(s.filter((x) => x.status === 'active')))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="page narrow">
      <h3>Choose a session to join</h3>
      {error && <div className="error-banner">{error}</div>}
      <div className="session-picker">
        {sessions.length === 0 && (
          <div className="empty-state">No active sessions right now. Check back soon.</div>
        )}
        {sessions.map((s) => (
          <div className="session-pick-card" key={s.id}>
            <div>
              <div className="session-name">{s.name}</div>
              <div className="session-meta">{s.stats.pending} remaining · {s.stats.done} done</div>
            </div>
            <button className="btn-primary" onClick={() => onPick(s)}>Join</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Main call card ───────────────────────────────────────────────── */

function CallCard({ session, onLeave }) {
  const [row,           setRow]          = useState(null);
  const [history,       setHistory]      = useState([]);
  const [finished,      setFinished]     = useState(false);
  const [error,         setError]        = useState('');
  const [loading,       setLoading]      = useState(true);
  const [submitting,    setSubmitting]   = useState(false);
  const [comment,       setComment]      = useState('');
  // The chosen disposition — caller picks one, then can optionally add a
  // comment, then clicks "Next" (or clicks the outcome button again to submit
  // immediately without a comment — same as before).
  const [pendingDisp,   setPendingDisp]  = useState(null);

  const fetching = useRef(false);

  // On mount (and only on mount) ask the server for our current row.
  // If we already have one assigned (resumed = true), show it without
  // clearing the comment — the user may have typed something before switching
  // apps. We don't clear the comment on resume, only on a genuine new row.
  useEffect(() => { initialFetch(); }, []); // eslint-disable-line

  const initialFetch = async () => {
    if (fetching.current) return;
    fetching.current = true;
    setLoading(true);
    setError('');
    try {
      const res = await api.nextRow(session.id);
      if (!res.row) {
        setFinished(true);
        setRow(null);
      } else {
        setRow(res.row);
        setFinished(false);
        // Only clear comment/disposition on a genuinely new row, not on resume.
        if (!res.resumed) { setComment(''); setPendingDisp(null); }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      fetching.current = false;
    }
  };

  // Fetch the NEXT row after successfully submitting a disposition.
  // Distinct from initialFetch: always clears the comment because this
  // is always a new row.
  const fetchNext = async () => {
    if (fetching.current) return;
    fetching.current = true;
    setLoading(true);
    setError('');
    try {
      const res = await api.nextRow(session.id);
      if (!res.row) {
        setFinished(true);
        setRow(null);
      } else {
        setRow(res.row);
        setFinished(false);
        setComment('');
        setPendingDisp(null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      fetching.current = false;
    }
  };

  // Step 1: caller taps an outcome button — this SELECTS it (highlights it)
  // but does NOT submit yet, giving them a chance to add a comment first.
  // If they tap the same button again it submits immediately (shortcut for
  // callers who don't want to write a comment).
  const handleDisposition = async (key) => {
    if (!row || submitting) return;
    if (pendingDisp === key) {
      // Second tap on same button = submit right now without waiting
      await doSubmit(key);
    } else {
      setPendingDisp(key);
    }
  };

  // Step 2: the "Next →" button — submits the selected disposition + comment.
  const doSubmit = async (disposition) => {
    if (!row || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await api.submitDisposition(row.id, disposition, comment);
      setHistory((h) => [...h, { ...row, disposition, comment }]);
      await fetchNext();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // "Next →" pressed — disposition must already be chosen
  const submitAndNext = async () => {
    if (!pendingDisp) {
      setError('Please choose an outcome first (No answer, Busy, Deal is done, etc.)');
      return;
    }
    await doSubmit(pendingDisp);
  };

  // Leave the current row pending without saving an outcome or comment.
  const skipAndNext = async () => {
    if (!row || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await api.releaseOwnRowAndGetNext(row.id);
      if (!res.row) {
        setFinished(true);
        setRow(null);
      } else {
        setRow(res.row);
        setFinished(false);
        setComment('');
        setPendingDisp(null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // Go back to the previous completed row (read-only view).
  const [viewingPrev, setViewingPrev] = useState(false);
  const [prevIndex,   setPrevIndex]   = useState(null);

  const goBack = () => {
    if (!history.length) return;
    setPrevIndex(history.length - 1);
    setViewingPrev(true);
  };

  const goForward = () => {
    if (prevIndex === null) return;
    if (prevIndex >= history.length - 1) {
      setViewingPrev(false);
      setPrevIndex(null);
    } else {
      setPrevIndex(prevIndex + 1);
    }
  };

  const goPrevStep = () => {
    if (prevIndex === null || prevIndex <= 0) return;
    setPrevIndex(prevIndex - 1);
  };

  const displayRow    = viewingPrev ? history[prevIndex] : row;
  const isPrevView    = viewingPrev;

  return (
    <div className="call-shell">
      {/* Top bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* ← Previous */}
          <button
            className="btn-secondary"
            style={{ padding: '7px 14px', fontSize: 13 }}
            disabled={history.length === 0}
            onClick={isPrevView ? goPrevStep : goBack}
            title="Go to previous student"
          >
            ← Prev
          </button>
          {isPrevView && (
            <button
              className="btn-secondary"
              style={{ padding: '7px 14px', fontSize: 13 }}
              onClick={goForward}
            >
              {prevIndex >= history.length - 1 ? 'Back to current' : 'Next →'}
            </button>
          )}
          <div style={{ fontWeight: 600 }}>{session.name}</div>
        </div>
        <button className="btn-ghost" onClick={onLeave}>Switch session</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* Previous-record notice */}
      {isPrevView && (
        <div style={{
          background: '#fef9e7', border: '1px solid #f0d98a', borderRadius: 10,
          padding: '10px 14px', fontSize: 13, marginBottom: 12, color: '#8a6d00'
        }}>
          Viewing previous record ({prevIndex + 1} of {history.length}) — already submitted as <strong>{
            DISPOSITIONS.find(d => d.key === history[prevIndex]?.disposition)?.label
            || history[prevIndex]?.disposition
          }</strong>. Read-only.
        </div>
      )}

      <div className="call-card">
        {loading ? (
          <div className="empty-state">Loading next record…</div>
        ) : finished && !isPrevView ? (
          <div className="empty-state">
            <div style={{ fontSize: 40, marginBottom: 10 }}>✓</div>
            All rows in this session have been handled.
          </div>
        ) : displayRow ? (
          <>
            <div className="student-name">{displayRow.name}</div>
            <div className="student-sub">
              {displayRow.student_id ? `ID ${displayRow.student_id} · ` : ''}
              {displayRow.grade || '—'} · {displayRow.subject || '—'}
            </div>

            <div className="contact-line">
              <div>
                <div className="label">Student phone</div>
                <div className="value mono">{displayRow.phone || '—'}</div>
              </div>
              <div className="actions"><CopyButton value={displayRow.phone} /></div>
            </div>
            <div className="contact-line">
              <div>
                <div className="label">Parent phone</div>
                <div className="value mono">{displayRow.parent_phone || '—'}</div>
              </div>
              <div className="actions"><CopyButton value={displayRow.parent_phone} /></div>
            </div>

            {/* Call / WhatsApp buttons — hidden when viewing prev (already done) */}
            {!isPrevView && (
              <div className="action-grid">
                <a href={`tel:${digitsOnly(displayRow.phone)}`}>
                  <button className="call-btn" style={{ width: '100%' }}>📞 Call student</button>
                </a>
                <a href={`tel:${digitsOnly(displayRow.parent_phone)}`}>
                  <button className="call-btn" style={{ width: '100%' }}>📞 Call parent</button>
                </a>
                <a href={`https://wa.me/${toWhatsAppNumber(displayRow.phone)}`} target="_blank" rel="noreferrer">
                  <button className="wa-btn" style={{ width: '100%' }}>💬 WhatsApp student</button>
                </a>
                <a href={`https://wa.me/${toWhatsAppNumber(displayRow.parent_phone)}`} target="_blank" rel="noreferrer">
                  <button className="wa-btn" style={{ width: '100%' }}>💬 WhatsApp parent</button>
                </a>
              </div>
            )}

            {/* Comment box */}
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 20, textAlign: 'left', fontWeight: 600 }}>
              {isPrevView ? 'Comment left on this record' : '2 — Add a comment (optional)'}
            </div>
            <textarea
              value={isPrevView ? (displayRow.comment || '—') : comment}
              onChange={isPrevView ? undefined : (e) => setComment(e.target.value)}
              readOnly={isPrevView}
              placeholder="Any notes about this call…"
              rows={3}
              style={{
                width: '100%', marginTop: 6, resize: 'vertical', fontFamily: 'inherit',
                background: isPrevView ? 'var(--bg)' : undefined,
              }}
            />

            {/* Outcome buttons — only for the live current record */}
            {!isPrevView && (
              <>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 16, textAlign: 'left', fontWeight: 600 }}>
                  1 — Choose an outcome
                </div>
                <div className="disposition-grid">
                  {DISPOSITIONS.map((d) => (
                    <button
                      key={d.key}
                      className={[
                        d.wide ? 'wide' : '',
                        d.key === 'rejected' ? 'reject' : '',
                        pendingDisp === d.key ? 'selected' : '',
                      ].filter(Boolean).join(' ')}
                      disabled={submitting}
                      onClick={() => handleDisposition(d.key)}
                    >
                      {pendingDisp === d.key ? '✓ ' : ''}{d.label}
                    </button>
                  ))}
                </div>

                {/* Submit the outcome when one is selected */}
                <button
                  className={pendingDisp ? 'btn-primary' : 'btn-secondary'}
                  style={{ width: '100%', marginTop: 12, padding: 13, fontSize: 14.5 }}
                  disabled={submitting || !pendingDisp}
                  onClick={submitAndNext}
                >
                  {submitting ? 'Saving…' : pendingDisp
                    ? `Submit & Next →`
                    : 'Choose an outcome first'}
                </button>

                <button
                  className="btn-secondary"
                  style={{ width: '100%', marginTop: 8, padding: 11, fontSize: 13.5 }}
                  disabled={submitting}
                  onClick={skipAndNext}
                >
                  {submitting ? 'Loading…' : 'Next without outcome →'}
                </button>

                {pendingDisp && (
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, textAlign: 'center' }}>
                    Tip: tap the same outcome button twice to submit instantly without clicking Next
                  </div>
                )}
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ── Root ─────────────────────────────────────────────────────────── */

export default function CallerScreen() {
  const [session, setSession] = useState(null);
  if (!session) return <SessionPicker onPick={setSession} />;
  return <CallCard session={session} onLeave={() => setSession(null)} />;
}
