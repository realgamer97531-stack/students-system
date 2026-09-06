import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, saveSession } from '../api';

export default function Login({ onLoggedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token, user } = await api.login(username, password);
      saveSession(token, user);
      onLoggedIn(user);
      navigate(user.role === 'admin' ? '/admin' : '/call');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page narrow" style={{ paddingTop: 80 }}>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <div style={{ fontWeight: 700, fontSize: 20 }}>Call Center Console</div>
        <div style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 4 }}>Sign in to continue</div>
      </div>
      <form className="card" onSubmit={submit}>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn-primary" style={{ width: '100%', padding: 12 }} disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
