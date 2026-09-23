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

function isAttendanceSession(session) {
  return /type:\s*present/i.test(session?.name || '');
}

const ATTENDANCE_LABELS = {
  attended: 'Attended',
  attended_elsewhere: 'Elsewhere',
  online: 'Online',
  cancelled: 'Cancelled',
  absent: 'Absent',
};

const HOMEWORK_LABELS = {
  complete: 'Complete',
  incomplete: 'Incomplete',
  no_steps: 'No steps',
  not_done: 'Not done',
};

function attendanceLabel(row) {
  if (row.attendance === 'attended_elsewhere') return row.elsewhereCenter || 'Elsewhere';
  return ATTENDANCE_LABELS[row.attendance] || row.attendance;
}

function formatWatchDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
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

// Isolates the optional student-history panel: if it ever throws, it just
// disappears instead of blanking the whole call card (the call itself must
// never depend on this rendering correctly).
class SummaryBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error) {
    console.error('Student history panel crashed:', error);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
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
  // Brief read-only student history (attendance/homework/exams) for whoever
  // is currently on the card — fetched live, never blocks the call flow.
  const [summary,       setSummary]      = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const fetching = useRef(false);

  // On mount (and only on mount) ask the server for our current row.
  // If we already have one assigned (resumed = true), show it without
  // clearing the comment — the user may have typed something before switching
  // apps. We don't clear the comment on resume, only on a genuine new row.
  useEffect(() => { initialFetch(); }, []); // eslint-disable-line

  // Load the brief student history whenever we land on a new row. Purely
  // informational for the caller, so a failure here is silent and never
  // blocks the call.
  useEffect(() => {
    if (!row?.id) { setSummary(null); return; }
    setSummary(null);
    setSummaryLoading(true);
    api.studentSummary(row.id)
      .then((res) => {
        const s = res && res.summary;
        // Guard against a stale/mismatched backend still on an older
        // response shape — never let a shape surprise crash the call card.
        const valid = s && s.totals && Array.isArray(s.rows) && Array.isArray(s.comments);
        // `videos` is a newer, optional field — default it so an older
        // backend response (missing it) still renders the rest fine.
        setSummary(valid ? { ...s, videos: Array.isArray(s.videos) ? s.videos : [] } : null);
      })
      .catch(() => setSummary(null))
      .finally(() => setSummaryLoading(false));
  }, [row?.id]);

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
      const result = await api.submitDisposition(row.id, disposition, comment);
      setHistory((h) => [...h, { ...row, disposition, comment }]);
      await fetchNext();
      if (!result.studentSystemSync) {
        setError(`Saved in call center, but the student follow-up dashboard was not updated${result.studentSystemSyncError ? `: ${result.studentSystemSyncError}` : '.'}`);
      }
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

  // Mark the row as skipped without requiring an outcome choice or comment.
  const skipAndNext = async () => {
    if (!row || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.submitDisposition(row.id, 'skipped', comment);
      setHistory((h) => [...h, { ...row, disposition: 'skipped', comment }]);
      await fetchNext();
      if (!result.studentSystemSync) {
        setError(`Saved in call center, but the student follow-up dashboard was not updated${result.studentSystemSyncError ? `: ${result.studentSystemSyncError}` : '.'}`);
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
  const showAttendanceDetails = isAttendanceSession(session);

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
              {displayRow.center || displayRow.grade || '—'} · {displayRow.subject || '—'}
            </div>

            {(summaryLoading || summary) && (
              <SummaryBoundary key={row?.id}>
              <div style={{ marginTop: 4, marginBottom: 4 }}>
                <div className="label" style={{ marginBottom: 6 }}>Student history</div>
                {summaryLoading ? (
                  <div className="value" style={{ fontSize: 12.5, fontWeight: 400 }}>Loading…</div>
                ) : (
                  <>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.6 }}>
                      {summary.totals.attended}/{summary.totals.totalLessons} attended
                      {summary.totals.absent > 0 ? `, ${summary.totals.absent} absent` : ''}
                      {summary.totals.cancelled > 0 ? `, ${summary.totals.cancelled} cancelled` : ''}
                      {summary.totals.online > 0 ? `, ${summary.totals.online} online` : ''}
                      {' · '}HW: {summary.totals.homeworkComplete} done
                      {summary.totals.homeworkIncomplete > 0 ? `, ${summary.totals.homeworkIncomplete} incomplete` : ''}
                      {summary.totals.homeworkNotDone > 0 ? `, ${summary.totals.homeworkNotDone} not done` : ''}
                      {summary.totals.examMaxTotal > 0 ? ` · Exams: ${summary.totals.examTotal}/${summary.totals.examMaxTotal}` : ''}
                    </div>

                    {summary.rows.length > 0 && (
                      <div style={{ overflowX: 'auto', marginBottom: 10, border: '1px solid var(--border, #e5e5e5)', borderRadius: 8 }}>
                        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ textAlign: 'left', color: 'var(--muted)', background: 'var(--bg)' }}>
                              <th style={{ padding: '5px 8px' }}>Lesson</th>
                              <th style={{ padding: '5px 8px' }}>Date</th>
                              <th style={{ padding: '5px 8px' }}>Attendance</th>
                              <th style={{ padding: '5px 8px' }}>Homework</th>
                              <th style={{ padding: '5px 8px' }}>Exam</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[...summary.rows].reverse().map((r) => (
                              <tr key={r.lesson} style={{ borderTop: '1px solid var(--border, #eee)' }}>
                                <td style={{ padding: '5px 8px' }}>{r.lesson}</td>
                                <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>{r.date || '—'}</td>
                                <td style={{ padding: '5px 8px' }}>{attendanceLabel(r)}</td>
                                <td style={{ padding: '5px 8px' }}>{HOMEWORK_LABELS[r.homework] || '—'}</td>
                                <td style={{ padding: '5px 8px' }}>{r.examScore != null ? `${r.examScore}/${r.examMax}` : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {summary.comments.length > 0 && (
                      <div style={{ overflowX: 'auto', border: '1px solid var(--border, #e5e5e5)', borderRadius: 8 }}>
                        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ textAlign: 'left', color: 'var(--muted)', background: 'var(--bg)' }}>
                              <th style={{ padding: '5px 8px' }}>Lesson</th>
                              <th style={{ padding: '5px 8px' }}>Date</th>
                              <th style={{ padding: '5px 8px' }}>By</th>
                              <th style={{ padding: '5px 8px' }}>Comment</th>
                            </tr>
                          </thead>
                          <tbody>
                            {summary.comments.map((c, i) => (
                              <tr key={i} style={{ borderTop: '1px solid var(--border, #eee)' }}>
                                <td style={{ padding: '5px 8px' }}>{c.lesson ?? '—'}</td>
                                <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>{c.date || '—'}</td>
                                <td style={{ padding: '5px 8px' }}>{c.by}</td>
                                <td style={{ padding: '5px 8px', whiteSpace: 'pre-wrap' }}>{c.comment}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {summary.videos.length > 0 && (
                      <div style={{ overflowX: 'auto', marginTop: 10, border: '1px solid var(--border, #e5e5e5)', borderRadius: 8 }}>
                        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ textAlign: 'left', color: 'var(--muted)', background: 'var(--bg)' }}>
                              <th style={{ padding: '5px 8px' }}>Lesson</th>
                              <th style={{ padding: '5px 8px' }}>Video</th>
                              <th style={{ padding: '5px 8px' }}>Watched</th>
                            </tr>
                          </thead>
                          <tbody>
                            {summary.videos.map((v, i) => (
                              <tr key={i} style={{ borderTop: '1px solid var(--border, #eee)' }}>
                                <td style={{ padding: '5px 8px' }}>{v.lesson ?? '—'}</td>
                                <td style={{ padding: '5px 8px' }}>{v.title}</td>
                                <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>
                                  {formatWatchDuration(v.watchedSeconds)} / {formatWatchDuration(v.durationSeconds)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>
              </SummaryBoundary>
            )}

            {showAttendanceDetails && (displayRow.homework_status || displayRow.exam_score !== null && displayRow.exam_score !== undefined) && (
              <div className="contact-line" style={{ display: 'block' }}>
                {displayRow.homework_status && (
                  <div><span className="label">Homework</span><div className="value">{displayRow.homework_status}</div></div>
                )}
                {displayRow.exam_score !== null && displayRow.exam_score !== undefined && (
                  <div style={{ marginTop: 8 }}><span className="label">Exam degree</span><div className="value">{displayRow.exam_score}{displayRow.exam_max ? ` / ${displayRow.exam_max}` : ''}</div></div>
                )}
              </div>
            )}

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
                  {submitting ? 'Saving…' : 'Next without outcome →'}
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
