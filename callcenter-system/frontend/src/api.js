const BASE = '/api';

function getToken() {
  return localStorage.getItem('cc_token');
}

async function request(path, { method = 'GET', body, isBlob = false, isFormData = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!isFormData && body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: isFormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch {}
    throw new Error(message);
  }

  if (isBlob) return res.blob();
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  login: (username, password) => request('/auth/login', { method: 'POST', body: { username, password } }),

  listUsers: () => request('/admin/users'),
  createUser: (data) => request('/admin/users', { method: 'POST', body: data }),
  setUserActive: (id, active) => request(`/admin/users/${id}/active`, { method: 'PATCH', body: { active } }),
  setUserPassword: (id, password) => request(`/admin/users/${id}/password`, { method: 'PATCH', body: { password } }),
  releaseRow: (id) => request(`/admin/rows/${id}/release`, { method: 'PATCH' }),
  stuckRows: (sessionId) => request(`/admin/sessions/${sessionId}/stuck`),

  listSessions: () => request('/sessions'),
  getSession: (id) => request(`/sessions/${id}`),
  sessionRows: (id, params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v !== undefined))
    ).toString();
    return request(`/sessions/${id}/rows${qs ? `?${qs}` : ''}`);
  },
  callerStats: (sessionId) => request(`/sessions/${sessionId}/caller-stats`),
  callerRowsInSession: (sessionId, userId) => request(`/sessions/${sessionId}/callers/${userId}/rows`),
  globalCallerStats: () => request('/admin/callers/stats'),
  createSession: (name, file) => {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('file', file);
    return request('/sessions', { method: 'POST', body: fd, isFormData: true });
  },
  addRows: (sessionId, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request(`/sessions/${sessionId}/rows`, { method: 'POST', body: fd, isFormData: true });
  },
  setSessionStatus: (id, status) => request(`/sessions/${id}/status`, { method: 'PATCH', body: { status } }),
  restartSession: (id, name, dispositions) =>
    request(`/sessions/${id}/restart`, { method: 'POST', body: { name, dispositions } }),
  exportSession: (id, onlyDone) => request(`/sessions/${id}/export${onlyDone ? '?onlyDone=true' : ''}`, { isBlob: true }),

  nextRow: (sessionId) => request(`/sessions/${sessionId}/next`, { method: 'POST' }),
  submitDisposition: (rowId, disposition, comment) =>
    request(`/rows/${rowId}/disposition`, { method: 'POST', body: { disposition, comment } }),
};

export function saveSession(token, user) {
  localStorage.setItem('cc_token', token);
  localStorage.setItem('cc_user', JSON.stringify(user));
}
export function clearSession() {
  localStorage.removeItem('cc_token');
  localStorage.removeItem('cc_user');
}
export function getUser() {
  const raw = localStorage.getItem('cc_user');
  return raw ? JSON.parse(raw) : null;
}
