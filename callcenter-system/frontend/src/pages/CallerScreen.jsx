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

/* ── My called students list ──────────────────────────────────────── */

function dispositionLabel(key) {
  if (key === 'skipped') return 'Skipped';
  return DISPOSITIONS.find((d) => d.key === key)?.label || key || '—';
}

function MyCallsModal({ rows, currentId, onClose, onPick }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // Newest call first; keep each row's index in `rows` for navigation.
  const items = rows
    .map((r, index) => ({ r, index }))
    .reverse()
    .filter(({ r }) => !q || [r.name, r.student_id, r.phone, r.parent_phone, r.comment]
      .some((v) => String(v || '').toLowerCase().includes(q)));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 520, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>My called students ({rows.length})</h3>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, ID, phone or comment…"
          style={{ marginBottom: 10 }}
        />
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {items.length === 0 && (
            <div className="empty-state">
              {rows.length === 0 ? "You haven't finished any calls in this session yet." : 'No matches.'}
            </div>
          )}
          {items.map(({ r, index }) => (
            <button
              key={r.id}
              onClick={() => onPick(index)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', marginBottom: 6,
                padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                border: `1px solid ${r.id === currentId ? 'var(--accent)' : 'var(--line)'}`,
                background: r.id === currentId ? '#e8f1ef' : 'var(--surface)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{index + 1}. {r.name}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', whiteSpace: 'nowrap' }}>
                  {dispositionLabel(r.disposition)}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                {r.student_id ? `ID ${r.student_id} · ` : ''}{r.phone || '—'}
              </div>
              {r.comment && (
                <div style={{
                  fontSize: 12, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {r.comment}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Main call card ───────────────────────────────────────────────── */

function CallCard({ session, onLeave }) {
  const [row,           setRow]          = useState(null);
  const [finished,      setFinished]     = useState(false);
  // Rows this caller already finished in this session (oldest first) plus
  // session counters — loaded from the server so Prev / "My called students"
  // survive a page refresh.
  const [myRows,        setMyRows]       = useState([]);
  const [progress,      setProgress]     = useState(null);
  // Index into myRows of the finished call being viewed/edited (null = live row).
  const [viewIndex,     setViewIndex]    = useState(null);
  const [editDisp,      setEditDisp]     = useState(null);
  const [editComment,   setEditComment]  = useState('');
  const [saving,        setSaving]       = useState(false);
  const [notice,        setNotice]       = useState('');
  const [showList,      setShowList]     = useState(false);
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

  // Progress counters + my finished calls. Refreshed after every submit/edit
  // and every 30s so "remaining" also reflects the other callers' work.
  const loadMine = () => api.myCalls(session.id)
    .then((res) => {
      setMyRows(Array.isArray(res.rows) ? res.rows : []);
      setProgress(res.progress || null);
    })
    .catch(() => {}); // counters are informational — never block the call
  useEffect(() => {
    loadMine();
    const t = setInterval(loadMine, 30000);
    return () => clearInterval(t);
  }, [session.id]); // eslint-disable-line

  const displayRow = viewIndex !== null ? myRows[viewIndex] : row;
  const isPrevView = viewIndex !== null && !!displayRow;

  // Load the brief student history whenever the card shows a different
  // student (live row or a finished one being reviewed). Purely
  // informational for the caller, so a failure here is silent and never
  // blocks the call.
  useEffect(() => {
    if (!displayRow?.id) { setSummary(null); setSummaryLoading(false); return; }
    setSummary(null);
    setSummaryLoading(true);
    // Ignore a late answer for a student we've already navigated away from.
    let stale = false;
    api.studentSummary(displayRow.id)
      .then((res) => {
        if (stale) return;
        const s = res && res.summary;
        // Guard against a stale/mismatched backend still on an older
        // response shape — never let a shape surprise crash the call card.
        const valid = s && s.totals && Array.isArray(s.rows) && Array.isArray(s.comments);
        // `videos` is a newer, optional field — default it so an older
        // backend response (missing it) still renders the rest fine.
        setSummary(valid ? { ...s, videos: Array.isArray(s.videos) ? s.videos : [] } : null);
      })
      .catch(() => { if (!stale) setSummary(null); })
      .finally(() => { if (!stale) setSummaryLoading(false); });
    return () => { stale = true; };
  }, [displayRow?.id]);

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
      await fetchNext();
      loadMine();
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
      await fetchNext();
      loadMine();
      if (!result.studentSystemSync) {
        setError(`Saved in call center, but the student follow-up dashboard was not updated${result.studentSystemSyncError ? `: ${result.studentSystemSyncError}` : '.'}`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // Open one of my finished calls for review/editing (null = back to live row).
  const openFinished = (index) => {
    setNotice('');
    setError('');
    if (index === null || !myRows[index]) {
      setViewIndex(null);
      return;
    }
    setViewIndex(index);
    setEditDisp(myRows[index].disposition || null);
    setEditComment(myRows[index].comment || '');
  };

  // ← Prev: from the live row jump to my most recent finished call, then keep
  // stepping back through older ones.
  const goPrev = () => {
    if (!myRows.length) return;
    if (viewIndex === null) openFinished(myRows.length - 1);
    else if (viewIndex > 0) openFinished(viewIndex - 1);
  };

  const goForward = () => {
    if (viewIndex === null) return;
    openFinished(viewIndex >= myRows.length - 1 ? null : viewIndex + 1);
  };

  const editChanged = isPrevView && (
    editDisp !== (displayRow.disposition || null)
    || editComment.trim() !== (displayRow.comment || '').trim()
  );

  // Save a corrected outcome/comment on a finished call (also re-syncs it to
  // the student follow-up dashboard, replacing the earlier text there).
  const saveEdit = async () => {
    if (!isPrevView || saving || !editDisp) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await api.editDisposition(displayRow.id, editDisp, editComment);
      if (result.row) {
        setMyRows((list) => list.map((r) => (r.id === result.row.id ? result.row : r)));
        setEditComment(result.row.comment || '');
      }
      if (!result.studentSystemSync) {
        setError(`Saved in call center, but the student follow-up dashboard was not updated${result.studentSystemSyncError ? `: ${result.studentSystemSyncError}` : '.'}`);
      } else {
        setNotice('Changes saved.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const showAttendanceDetails = isAttendanceSession(session);

  return (
    <div className="call-shell">
      {/* Top bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* ← Previous */}
          <button
            className="btn-secondary"
            style={{ padding: '7px 14px', fontSize: 13 }}
            disabled={myRows.length === 0 || viewIndex === 0}
            onClick={goPrev}
            title="Go to the previous student you called"
          >
            ← Prev
          </button>
          {isPrevView && (
            <button
              className="btn-secondary"
              style={{ padding: '7px 14px', fontSize: 13 }}
              onClick={goForward}
            >
              {viewIndex >= myRows.length - 1 ? 'Back to current' : 'Next →'}
            </button>
          )}
          <button
            className="btn-secondary"
            style={{ padding: '7px 14px', fontSize: 13 }}
            onClick={() => setShowList(true)}
            title="Students you already called in this session"
          >
            ☰ My called students
          </button>
        </div>
        <button className="btn-ghost" onClick={onLeave}>Switch session</button>
      </div>
      <div style={{ fontWeight: 600, marginBottom: 10 }}>{session.name}</div>

      {/* Progress counters — refreshed after every call */}
      {progress && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 14,
        }}>
          {[
            { label: 'You finished', value: progress.mine_done, color: 'var(--good)' },
            { label: 'Remaining', value: progress.remaining, color: 'var(--warn)' },
            { label: 'Session done', value: `${progress.done} / ${progress.total}`, color: 'var(--ink)' },
          ].map((c) => (
            <div key={c.label} style={{
              background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10,
              padding: '8px 10px', textAlign: 'center',
            }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: c.color }}>{c.value}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>{c.label}</div>
            </div>
          ))}
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}
      {notice && (
        <div style={{
          background: '#e3f4ea', color: 'var(--good)', border: '1px solid #bfe3cd',
          padding: '10px 14px', borderRadius: 8, fontSize: 13.5, marginBottom: 16,
        }}>{notice}</div>
      )}

      {/* Previous-record notice */}
      {isPrevView && (
        <div style={{
          background: '#fef9e7', border: '1px solid #f0d98a', borderRadius: 10,
          padding: '10px 14px', fontSize: 13, marginBottom: 12, color: '#8a6d00'
        }}>
          Editing a call you already finished ({viewIndex + 1} of {myRows.length}) — saved as <strong>{
            DISPOSITIONS.find(d => d.key === displayRow.disposition)?.label
            || (displayRow.disposition === 'skipped' ? 'Skipped' : displayRow.disposition)
          }</strong>. Your current student is kept for you — press "Back to current" when done.
        </div>
      )}

      <div className="call-card">
        {loading && !isPrevView ? (
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
              <SummaryBoundary key={displayRow.id}>
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

            {/* Call / WhatsApp buttons (also on finished calls, to call back) */}
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

            {isPrevView ? (
              <>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 20, textAlign: 'left', fontWeight: 600 }}>
                  Outcome
                </div>
                <div className="disposition-grid">
                  {DISPOSITIONS.map((d) => (
                    <button
                      key={d.key}
                      className={[
                        d.wide ? 'wide' : '',
                        d.key === 'rejected' ? 'reject' : '',
                        editDisp === d.key ? 'selected' : '',
                      ].filter(Boolean).join(' ')}
                      disabled={saving}
                      onClick={() => setEditDisp(d.key)}
                    >
                      {editDisp === d.key ? '✓ ' : ''}{d.label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 16, textAlign: 'left', fontWeight: 600 }}>
                  Comment
                </div>
                <textarea
                  value={editComment}
                  onChange={(e) => setEditComment(e.target.value)}
                  placeholder="Any notes about this call…"
                  rows={3}
                  style={{ width: '100%', marginTop: 6, resize: 'vertical', fontFamily: 'inherit' }}
                />
                <button
                  className={editChanged ? 'btn-primary' : 'btn-secondary'}
                  style={{ width: '100%', marginTop: 12, padding: 13, fontSize: 14.5 }}
                  disabled={saving || !editChanged || !editDisp}
                  onClick={saveEdit}
                >
                  {saving ? 'Saving…' : editChanged ? 'Save changes' : 'No changes to save'}
                </button>
                <button
                  className="btn-secondary"
                  style={{ width: '100%', marginTop: 8, padding: 11, fontSize: 13.5 }}
                  disabled={saving}
                  onClick={() => openFinished(null)}
                >
                  Back to current student
                </button>
              </>
            ) : (
              <>
                {/* Comment box */}
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 20, textAlign: 'left', fontWeight: 600 }}>
                  2 — Add a comment (optional)
                </div>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Any notes about this call…"
                  rows={3}
                  style={{ width: '100%', marginTop: 6, resize: 'vertical', fontFamily: 'inherit' }}
                />
              </>
            )}

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

      {showList && (
        <MyCallsModal
          rows={myRows}
          currentId={isPrevView ? displayRow.id : null}
          onClose={() => setShowList(false)}
          onPick={(index) => { setShowList(false); openFinished(index); }}
        />
      )}
    </div>
  );
}

/* ── Root ─────────────────────────────────────────────────────────── */

export default function CallerScreen() {
  const [session, setSession] = useState(null);
  if (!session) return <SessionPicker onPick={setSession} />;
  return <CallCard session={session} onLeave={() => setSession(null)} />;
}
