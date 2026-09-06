const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// --- Global caller performance, across all sessions ---

router.get('/callers/stats', async (req, res) => {
  try {
    const [stats] = await pool.query(`
      SELECT u.id as user_id, u.name, u.username, u.active,
        COUNT(r.id) as total_assigned,
        SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) as done_count,
        SUM(CASE WHEN r.status = 'assigned' THEN 1 ELSE 0 END) as in_progress_count,
        SUM(CASE WHEN r.disposition = 'no_answer' THEN 1 ELSE 0 END) as no_answer,
        SUM(CASE WHEN r.disposition = 'busy' THEN 1 ELSE 0 END) as busy,
        SUM(CASE WHEN r.disposition = 'wrong_number' THEN 1 ELSE 0 END) as wrong_number,
        SUM(CASE WHEN r.disposition = 'follow_up' THEN 1 ELSE 0 END) as follow_up,
        SUM(CASE WHEN r.disposition = 'deal_done' THEN 1 ELSE 0 END) as deal_done
      FROM users u LEFT JOIN call_rows r ON r.assigned_to = u.id
      WHERE u.role = 'caller'
      GROUP BY u.id
      ORDER BY done_count DESC
    `);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Caller / user management ---

router.get('/users', async (req, res) => {
  try {
    const [users] = await pool.query(
      'SELECT id, username, name, role, active, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users', async (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name) {
    return res.status(400).json({ error: 'username, password and name are required' });
  }
  const finalRole = role === 'admin' ? 'admin' : 'caller';

  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length) return res.status(409).json({ error: 'That username is already taken' });

    const hash = bcrypt.hashSync(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (username, password_hash, name, role, active) VALUES (?, ?, ?, ?, 1)',
      [username, hash, name, finalRole]
    );

    res.status(201).json({ id: result.insertId, username, name, role: finalRole, active: 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/users/:id/active', async (req, res) => {
  const { active } = req.body;
  try {
    await pool.query('UPDATE users SET active = ? WHERE id = ?', [active ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/users/:id/password', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password is required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Release a row stuck on a caller (e.g. they disconnected mid-call) ---

router.patch('/rows/:id/release', async (req, res) => {
  try {
    const [rowsRes] = await pool.query('SELECT * FROM call_rows WHERE id = ?', [req.params.id]);
    const row = rowsRes[0];
    if (!row) return res.status(404).json({ error: 'Row not found' });
    if (row.status !== 'assigned') {
      return res.status(400).json({ error: 'Only assigned (in-progress) rows can be released' });
    }
    await pool.query(
      "UPDATE call_rows SET status = 'pending', assigned_to = NULL, assigned_at = NULL WHERE id = ?",
      [row.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List currently "stuck" rows (assigned) across a session, for admin visibility
router.get('/sessions/:id/stuck', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*, u.name as assigned_to_name FROM call_rows r
       LEFT JOIN users u ON u.id = r.assigned_to
       WHERE r.session_id = ? AND r.status = 'assigned'
       ORDER BY r.assigned_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
