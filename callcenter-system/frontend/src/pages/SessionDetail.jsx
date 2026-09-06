import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';

const STATUS_LABEL = { pending: 'Pending', assigned: 'In progress', done: 'Done' };
const DISPOSITION_LABEL = {
  no_answer:    'No answer',
  busy:         'Busy',
  wrong_number: 'Wrong number',
  follow_up:    'Follow up',
  rejected:     'Rejected',
  skipped:      'Skipped',
  deal_done:    'Deal is done',
};

function StatusPill({ status }) {
  const color = status === 'done' ? 'var(--good)' : status === 'assigned' ? 'var(--warn)' : 'var(--muted)';
  return <span style={{ color, fontWeight: 600, fontSize: 13 }}>{STATUS_LABEL[status] || status}</span>;
}

// --- Data tab: the excel-like table ---
function DataTab({ sessionId, callers }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ status: '', disposition: '', assignedTo: '', search: '' });
  const [loading, setLoading] = useState(true);
  const pageSize = 25;

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.sessionRows(sessionId, { ...filters, page, pageSize });
      setRows(res.rows);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [sessionId, page, filters]); // eslint-disable-line

  const updateFilter = (key, value) => {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const totalPages = Math.max(Math.ceil(total / pageSize), 1);

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          placeholder="Search name or phone…"
          value={filters.search}
          onChange={(e) => updateFilter('search', e.target.value)}
          style={{ minWidth: 200 }}
        />
        <select value={filters.status} onChange={(e) => updateFilter('status', e.target.value)}>
          <option value="">Any status</option>
          <option value="pending">Pending</option>
          <option value="assigned">In progress</option>
          <option value="done">Done</option>
        </select>
        <select value={filters.disposition} onChange={(e) => updateFilter('disposition', e.target.value)}>
          <option value="">Any outcome</option>
          {Object.entries(DISPOSITION_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <select value={filters.assignedTo} onChange={(e) => updateFilter('assignedTo', e.target.value)}>
          <option value="">Any caller</option>
          {callers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)', color: 'var(--muted)' }}>
              {['#', 'Student ID', 'Name', 'Phone', 'Parent phone', 'Grade', 'Subject', 'Status', 'Outcome', 'Comment', 'Assigned to', 'Completed'].map((h) => (
                <th key={h} style={{ padding: '10px 14px', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={{ padding: '9px 14px', color: 'var(--muted)' }}>{r.row_index}</td>
                <td className="mono" style={{ padding: '9px 14px' }}>{r.student_id || '—'}</td>
                <td style={{ padding: '9px 14px', fontWeight: 600 }}>{r.name}</td>
                <td className="mono" style={{ padding: '9px 14px' }}>{r.phone}</td>
                <td className="mono" style={{ padding: '9px 14px' }}>{r.parent_phone}</td>
                <td style={{ padding: '9px 14px' }}>{r.grade}</td>
                <td style={{ padding: '9px 14px' }}>{r.subject}</td>
                <td style={{ padding: '9px 14px' }}><StatusPill status={r.status} /></td>
                <td style={{ padding: '9px 14px' }}>{r.disposition ? DISPOSITION_LABEL[r.disposition] : '—'}</td>
                <td style={{ padding: '9px 14px', maxWidth: 220, color: r.comment ? 'inherit' : 'var(--muted)' }}>
                  {r.comment || '—'}
                </td>
                <td style={{ padding: '9px 14px' }}>{r.assigned_to_name || '—'}</td>
                <td style={{ padding: '9px 14px', color: 'var(--muted)' }}>
                  {r.completed_at ? new Date(r.completed_at + 'Z').toLocaleString() : '—'}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={12} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No rows match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 13 }}>
        <span style={{ color: 'var(--muted)' }}>{total} row{total === 1 ? '' : 's'} total</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span>Page {page} of {totalPages}</span>
          <button className="btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}

// --- Callers tab: performance breakdown + drill-down ---
function CallersTab({ sessionId }) {
  const [stats, setStats] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [drillRows, setDrillRows] = useState([]);

  useEffect(() => { api.callerStats(sessionId).then(setStats); }, [sessionId]);

  const toggleExpand = async (userId) => {
    if (expanded === userId) { setExpanded(null); return; }
    const rows = await api.callerRowsInSession(sessionId, userId);
    setDrillRows(rows);
    setExpanded(userId);
  };

  return (
    <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)', color: 'var(--muted)' }}>
            {['Caller', 'Assigned', 'Done', 'In progress', 'No answer', 'Busy', 'Wrong #', 'Follow up', 'Deal done', ''].map((h) => (
              <th key={h} style={{ padding: '10px 14px', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <React.Fragment key={s.user_id}>
              <tr style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={{ padding: '9px 14px', fontWeight: 600 }}>{s.name}</td>
                <td style={{ padding: '9px 14px' }}>{s.total_assigned}</td>
                <td style={{ padding: '9px 14px' }}>{s.done_count}</td>
                <td style={{ padding: '9px 14px' }}>{s.in_progress_count}</td>
                <td style={{ padding: '9px 14px' }}>{s.no_answer}</td>
                <td style={{ padding: '9px 14px' }}>{s.busy}</td>
                <td style={{ padding: '9px 14px' }}>{s.wrong_number}</td>
                <td style={{ padding: '9px 14px' }}>{s.follow_up}</td>
                <td style={{ padding: '9px 14px', fontWeight: 600, color: 'var(--good)' }}>{s.deal_done}</td>
                <td style={{ padding: '9px 14px' }}>
                  <button className="btn-ghost" onClick={() => toggleExpand(s.user_id)}>
                    {expanded === s.user_id ? 'Hide' : 'View calls'}
                  </button>
                </td>
              </tr>
              {expanded === s.user_id && (
                <tr>
                  <td colSpan={10} style={{ padding: '0 14px 16px', background: 'var(--bg)' }}>
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 600, margin: '10px 0 6px' }}>
                      Every row assigned to {s.name}
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <tbody>
                        {drillRows.map((r) => (
                          <tr key={r.id} style={{ borderBottom: '1px solid var(--line)' }}>
                            <td style={{ padding: '6px 0', fontWeight: 600 }}>{r.name}</td>
                            <td className="mono" style={{ padding: '6px 10px' }}>{r.phone}</td>
                            <td style={{ padding: '6px 10px' }}><StatusPill status={r.status} /></td>
                            <td style={{ padding: '6px 10px' }}>{r.disposition ? DISPOSITION_LABEL[r.disposition] : '—'}</td>
                            <td style={{ padding: '6px 10px', color: r.comment ? 'inherit' : 'var(--muted)', maxWidth: 200 }}>
                              {r.comment || '—'}
                            </td>
                            <td style={{ padding: '6px 10px', color: 'var(--muted)' }}>
                              {r.assigned_at ? new Date(r.assigned_at + 'Z').toLocaleString() : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
          {stats.length === 0 && (
            <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No calls made in this session yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function SessionDetail() {
  const { id } = useParams();
  const [session, setSession] = useState(null);
  const [callers, setCallers] = useState([]);
  const [tab, setTab] = useState('data');

  useEffect(() => {
    api.getSession(id).then(setSession);
    api.listUsers().then((u) => setCallers(u.filter((x) => x.role === 'caller')));
  }, [id]);

  if (!session) return <div className="page">Loading…</div>;

  return (
    <div className="page">
      <Link to="/admin" className="btn-ghost" style={{ display: 'inline-block', marginBottom: 10 }}>← All sessions</Link>
      <h2 style={{ marginBottom: 4 }}>{session.name}</h2>
      <div style={{ color: 'var(--muted)', fontSize: 13.5, marginBottom: 20 }}>
        {session.stats.total} rows · {session.stats.done} done · {session.stats.pending} pending
      </div>
      <div className="tabs">
        <button className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')}>Data</button>
        <button className={tab === 'callers' ? 'active' : ''} onClick={() => setTab('callers')}>Caller performance</button>
      </div>
      {tab === 'data' ? <DataTab sessionId={id} callers={callers} /> : <CallersTab sessionId={id} />}
    </div>
  );
}
