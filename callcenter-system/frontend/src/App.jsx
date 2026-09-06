import React, { useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { getUser, clearSession } from './api';
import Login from './pages/Login.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import SessionDetail from './pages/SessionDetail.jsx';
import CallerScreen from './pages/CallerScreen.jsx';

function Topbar({ user, onLogout }) {
  return (
    <div className="topbar">
      <div className="brand">
        <span className="dot" />
        Call Center Console
      </div>
      <div className="who">
        <span>{user.name} · {user.role === 'admin' ? 'Admin' : 'Caller'}</span>
        <button className="logout" onClick={onLogout}>Log out</button>
      </div>
    </div>
  );
}

function Protected({ role, children }) {
  const user = getUser();
  if (!user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to={user.role === 'admin' ? '/admin' : '/call'} replace />;
  return children;
}

export default function App() {
  const [user, setUser] = useState(getUser());
  const navigate = useNavigate();

  const handleLogout = () => {
    clearSession();
    setUser(null);
    navigate('/login');
  };

  return (
    <Routes>
      <Route path="/login" element={<Login onLoggedIn={setUser} />} />
      <Route
        path="/admin"
        element={
          <Protected role="admin">
            <Topbar user={user || {}} onLogout={handleLogout} />
            <AdminDashboard />
          </Protected>
        }
      />
      <Route
        path="/admin/sessions/:id"
        element={
          <Protected role="admin">
            <Topbar user={user || {}} onLogout={handleLogout} />
            <SessionDetail />
          </Protected>
        }
      />
      <Route
        path="/call"
        element={
          <Protected role="caller">
            <Topbar user={user || {}} onLogout={handleLogout} />
            <CallerScreen />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to={user ? (user.role === 'admin' ? '/admin' : '/call') : '/login'} replace />} />
    </Routes>
  );
}
