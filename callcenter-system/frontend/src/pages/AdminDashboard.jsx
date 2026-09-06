import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

const DISPOSITIONS = [
  { key: 'no_answer',    label: 'No answer' },
  { key: 'busy',         label: 'Busy' },
  { key: 'wrong_number', label: 'Wrong number' },
  { key: 'follow_up',    label: 'Follow up' },
  { key: 'rejected',     label: 'Rejected' },
  { key: 'skipped',      label: 'Skipped' },
  { key: 'deal_done',    label: 'Deal is done' },
];

function StatusBadge({ status }) {
  return <span className={`badge ${status}`}>{status === 'active' ? 'Active' : 'Inactive'}</span>;
}

function ProgressBar({ stats }) {
  const total = stats.total || 1;
  const donePct = Math.round((stats.done / total) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div className="progress-bar"><div style={{ width: `${donePct}%` }} /></div>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
        {stats.done}/{stats.total} done{stats.assigned ? ` · ${stats.assigned} in progress` : ''}
      </span>
    </div>
  );
}

// --- Create session modal (also used for "add rows to existing session") ---
function UploadModal({ mode, session, onClose, onDone }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError('');
    if (!file) return setError('Choose an excel file first.');
    if (mode === 'create' && !name.trim()) return setError('Give the session a name.');
    setLoading(true);
    try {
      const result =
        mode === 'create' ? await api.createSession(name.trim(), file) : await api.addRows(session.id, file);
      onDone(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{mode === 'create' ? 'New calling session' : `Add data to "${session.name}"`}</h3>
        {error && <div className="error-banner">{error}</div>}
        {mode === 'create' && (
          <div className="field">
            <label>Session name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. July intake batch" autoFocus />
          </div>
        )}
        <div className="field">
          <label>Excel file (.xlsx)</label>
          <input type="file" accept=".xlsx,.xls" onChange={(e) => setFile(e.target.files[0])} />
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Required columns: Name, Phone, Parent Phone, Grade, Subject
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={loading}>
            {loading ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Restart-with-filter modal ---
function RestartModal({ session, onClose, onDone }) {
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const toggle = (key) => setChosen((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));

  const submit = async () => {
    setError('');
    if (!chosen.length) return setError('Pick at least one disposition to include.');
    setLoading(true);
    try {
      const result = await api.restartSession(session.id, name.trim(), chosen);
      onDone(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Restart "{session.name}"</h3>
        <p style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: -8 }}>
          Creates a brand new session containing only the rows that ended with the dispositions you pick below.
        </p>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label>Include rows with disposition</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {['no_answer', 'follow_up', 'rejected', 'skipped'].map((key) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 500 }}>
                <input type="checkbox" checked={chosen.includes(key)} onChange={() => toggle(key)} />
                {DISPOSITIONS.find((d) => d.key === key).label}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <label>New session name (optional)</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${session.name} (restart)`} />
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={loading}>
            {loading ? 'Creating…' : 'Create session'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionsTab() {
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // { mode: 'create'|'add', session }
  const [restartFor, setRestartFor] = useState(null);

  const load = async () => {
    try {
      setSessions(await api.listSessions());
    } catch (err) {
      setError(err.message);
    }
  };
  useEffect(() => { load(); }, []);

  const toggleStatus = async (s) => {
    await api.setSessionStatus(s.id, s.status === 'active' ? 'inactive' : 'active');
    load();
  };

  const doExport = async (s, onlyDone) => {
    const blob = await api.exportSession(s.id, onlyDone);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${s.name}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button className="btn-primary" onClick={() => setModal({ mode: 'create' })}>+ New session</button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="card">
        {sessions.length === 0 && <div className="empty-state">No sessions yet. Create one to get started.</div>}
        {sessions.map((s) => (
          <div className="session-row" key={s.id}>
            <div style={{ flex: 1 }}>
              <div className="session-name">
                <Link to={`/admin/sessions/${s.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  {s.name}
                </Link>{' '}
                <StatusBadge status={s.status} />
              </div>
              <div className="session-meta">
                {s.parent_session_id ? `Restarted from session #${s.parent_session_id} · ` : ''}
                Created {new Date(s.created_at).toLocaleString()}
              </div>
              <div style={{ marginTop: 8 }}><ProgressBar stats={s.stats} /></div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 400 }}>
              <Link to={`/admin/sessions/${s.id}`}><button className="btn-ghost">View data</button></Link>
              <button className="btn-ghost" onClick={() => toggleStatus(s)}>
                {s.status === 'active' ? 'Deactivate' : 'Activate'}
              </button>
              <button className="btn-ghost" onClick={() => setModal({ mode: 'add', session: s })}>Add data</button>
              <button className="btn-ghost" onClick={() => setRestartFor(s)}>Restart</button>
              <button className="btn-ghost" onClick={() => doExport(s, false)}>Export all</button>
              <button className="btn-ghost" onClick={() => doExport(s, true)}>Export done</button>
            </div>
          </div>
        ))}
      </div>

      {modal && (
        <UploadModal
          mode={modal.mode}
          session={modal.session}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); load(); }}
        />
      )}
      {restartFor && (
        <RestartModal
          session={restartFor}
          onClose={() => setRestartFor(null)}
          onDone={() => { setRestartFor(null); load(); }}
        />
      )}
    </div>
  );
}

function CallersTab() {
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState({});
  const [error, setError] = useState('');
  const [form, setForm] = useState({ username: '', password: '', name: '', role: 'caller' });
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      const [userList, statList] = await Promise.all([api.listUsers(), api.globalCallerStats()]);
      setUsers(userList);
      const map = {};
      statList.forEach((s) => { map[s.user_id] = s; });
      setStats(map);
    } catch (err) { setError(err.message); }
  };
  useEffect(() => { load(); }, []);

  const createUser = async (e) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      await api.createUser(form);
      setForm({ username: '', password: '', name: '', role: 'caller' });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20 }}>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)', color: 'var(--muted)' }}>
              {['Name', 'Role', 'Status', 'Assigned (all-time)', 'Done', 'Deals', ''].map((h) => (
                <th key={h} style={{ padding: '10px 14px', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const s = stats[u.id];
              return (
                <tr key={u.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: '9px 14px', fontWeight: 600 }}>{u.name} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>@{u.username}</span></td>
                  <td style={{ padding: '9px 14px' }}>{u.role === 'admin' ? 'Admin' : 'Caller'}</td>
                  <td style={{ padding: '9px 14px' }}>{u.active ? 'Active' : 'Deactivated'}</td>
                  <td style={{ padding: '9px 14px' }}>{s ? s.total_assigned : '—'}</td>
                  <td style={{ padding: '9px 14px' }}>{s ? s.done_count : '—'}</td>
                  <td style={{ padding: '9px 14px', fontWeight: 600, color: 'var(--good)' }}>{s ? s.deal_done : '—'}</td>
                  <td style={{ padding: '9px 14px' }}>
                    <button className="btn-ghost" onClick={() => api.setUserActive(u.id, u.active ? 0 : 1).then(load)}>
                      {u.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {users.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No accounts yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <form className="card" onSubmit={createUser}>
        <h4 style={{ marginTop: 0 }}>New account</h4>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label>Full name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </div>
        <div className="field">
          <label>Username</label>
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </div>
        <div className="field">
          <label>Role</label>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="caller">Caller</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button className="btn-primary" style={{ width: '100%' }} disabled={creating}>
          {creating ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </div>
  );
}

export default function AdminDashboard() {
  const [tab, setTab] = useState('sessions');
  return (
    <div className="page">
      <div className="tabs">
        <button className={tab === 'sessions' ? 'active' : ''} onClick={() => setTab('sessions')}>Sessions</button>
        <button className={tab === 'callers' ? 'active' : ''} onClick={() => setTab('callers')}>Callers</button>
      </div>
      {tab === 'sessions' ? <SessionsTab /> : <CallersTab />}
    </div>
  );
}
