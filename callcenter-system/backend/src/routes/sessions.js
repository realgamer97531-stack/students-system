const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { parseStudentsExcel, buildExportExcel } = require('../utils/excel');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

const VALID_DISPOSITIONS = ['no_answer', 'busy', 'wrong_number', 'follow_up', 'rejected', 'skipped', 'deal_done'];

function hasValidServiceToken(req) {
  const configuredToken = process.env.CALLCENTER_SERVICE_TOKEN;
  const suppliedToken = req.headers['x-callcenter-service-token'];
  return Boolean(configuredToken && suppliedToken && suppliedToken === configuredToken);
}

async function sessionStats(sessionId) {
  const [rows] = await pool.query(
    `SELECT status, COUNT(*) as c FROM call_rows WHERE session_id = ? GROUP BY status`,
    [sessionId]
  );
  const stats = { pending: 0, assigned: 0, done: 0, total: 0 };
  rows.forEach((r) => {
    stats[r.status] = r.c;
    stats.total += r.c;
  });
  return stats;
}

// Inserts many student rows in one round trip. When withSourceId is true,
// each student object's own "id" is carried over into source_row_id (used
// when restarting a session from a filtered subset of a previous one).
async function bulkInsertRows(conn, sessionId, startIndex, students, withSourceId) {
  if (!students.length) return;
  const values = [];
  const placeholders = students
    .map((s, i) => {
      values.push(
        sessionId,
        startIndex + i,
        s.student_id || null,
        s.name,
        s.phone || null,
        s.parent_phone || null,
        s.center || null,
        s.grade || null,
        s.subject || null,
        s.homework_status || null,
        s.exam_score === '' || s.exam_score === undefined ? null : s.exam_score,
        s.exam_max === '' || s.exam_max === undefined ? null : s.exam_max,
        withSourceId ? s.id : null
      );
      return '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    })
    .join(', ');
  await conn.query(
    `INSERT INTO call_rows (session_id, row_index, student_id, name, phone, parent_phone, center, grade, subject, homework_status, exam_score, exam_max, source_row_id)
     VALUES ${placeholders}`,
    values
  );
}

// --- List sessions (both admin and callers can see active ones) ---

router.get('/', requireAuth, async (req, res) => {
  try {
    const [sessions] = await pool.query('SELECT * FROM sessions ORDER BY created_at DESC');
    const withStats = await Promise.all(
      sessions.map(async (s) => ({ ...s, stats: await sessionStats(s.id) }))
    );
    res.json(withStats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    const session = rows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ ...session, stats: await sessionStats(session.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Create a brand new session from an uploaded excel file ---

router.post('/', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Session name is required' });
  if (!req.file) return res.status(400).json({ error: 'An excel file is required' });

  let students;
  try {
    students = parseStudentsExcel(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO sessions (name, status, created_by) VALUES (?, ?, ?)',
      [name, 'active', req.user.id]
    );
    const sessionId = result.insertId;
    await bulkInsertRows(conn, sessionId, 1, students, false);
    await conn.commit();

    const [sessionRows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    res.status(201).json({
      ...sessionRows[0],
      stats: await sessionStats(sessionId),
      imported: students.length,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// Optional tracker integration. The existing JWT/multipart workflow above remains unchanged.
router.post('/internal', async (req, res) => {
  if (!hasValidServiceToken(req)) return res.status(401).json({ error: 'Invalid service token' });

  const { name, students } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Session name is required' });
  if (!Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ error: 'At least one student is required' });
  }

  const normalizedStudents = students
    .filter(student => student && String(student.name || '').trim())
    .map(student => ({
      student_id: student.student_id || student.id || null,
      name: String(student.name).trim(),
      phone: student.phone || null,
      parent_phone: student.parent_phone || null,
      center: student.center || null,
      grade: student.grade || null,
      subject: student.subject || null,
      homework_status: student.homework_status || null,
      exam_score: student.exam_score ?? null,
      exam_max: student.exam_max ?? null,
    }));

  if (normalizedStudents.length === 0) {
    return res.status(400).json({ error: 'No valid students were supplied' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO sessions (name, status, created_by) VALUES (?, ?, ?)',
      [name.trim(), 'active', null]
    );
    await bulkInsertRows(conn, result.insertId, 1, normalizedStudents, false);
    await conn.commit();

    const [sessionRows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [result.insertId]);
    res.status(201).json({
      ...sessionRows[0],
      stats: await sessionStats(result.insertId),
      imported: normalizedStudents.length,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// --- Add more rows to an existing session from a new excel file ---

router.post('/:id/rows', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const [sessionRows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    const session = sessionRows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!req.file) return res.status(400).json({ error: 'An excel file is required' });

    let students;
    try {
      students = parseStudentsExcel(req.file.buffer);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const [maxRowRes] = await pool.query(
      'SELECT COALESCE(MAX(row_index), 0) as m FROM call_rows WHERE session_id = ?',
      [session.id]
    );
    const maxRow = maxRowRes[0].m;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await bulkInsertRows(conn, session.id, maxRow + 1, students, false);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ ...session, stats: await sessionStats(session.id), imported: students.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Excel-like table view of a session's rows, with filters + pagination ---

router.get('/:id/rows', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sessionRows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    const session = sessionRows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { status, disposition, assignedTo, search } = req.query;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.min(parseInt(req.query.pageSize) || 50, 200);

    const conditions = ['r.session_id = ?'];
    const params = [session.id];
    if (status) { conditions.push('r.status = ?'); params.push(status); }
    if (disposition) { conditions.push('r.disposition = ?'); params.push(disposition); }
    if (assignedTo) { conditions.push('r.assigned_to = ?'); params.push(assignedTo); }
    if (search) {
      conditions.push('(r.name LIKE ? OR r.phone LIKE ? OR r.parent_phone LIKE ? OR r.student_id LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const where = conditions.join(' AND ');

    const [totalRes] = await pool.query(`SELECT COUNT(*) as c FROM call_rows r WHERE ${where}`, params);
    const total = totalRes[0].c;
    const offset = (page - 1) * pageSize;
    const [rows] = await pool.query(
      `SELECT r.*, u.name as assigned_to_name, u.username as assigned_to_username
       FROM call_rows r LEFT JOIN users u ON u.id = r.assigned_to
       WHERE ${where}
       ORDER BY r.row_index ASC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({ rows, total, page, pageSize });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Per-caller performance breakdown within one session ---

router.get('/:id/caller-stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sessionRows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!sessionRows[0]) return res.status(404).json({ error: 'Session not found' });

    const [stats] = await pool.query(
      `SELECT u.id as user_id, u.name, u.username,
         COUNT(r.id) as total_assigned,
         SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) as done_count,
         SUM(CASE WHEN r.status = 'assigned' THEN 1 ELSE 0 END) as in_progress_count,
         SUM(CASE WHEN r.disposition = 'no_answer' THEN 1 ELSE 0 END) as no_answer,
         SUM(CASE WHEN r.disposition = 'busy' THEN 1 ELSE 0 END) as busy,
         SUM(CASE WHEN r.disposition = 'wrong_number' THEN 1 ELSE 0 END) as wrong_number,
         SUM(CASE WHEN r.disposition = 'follow_up' THEN 1 ELSE 0 END) as follow_up,
         SUM(CASE WHEN r.disposition = 'deal_done' THEN 1 ELSE 0 END) as deal_done
       FROM call_rows r JOIN users u ON u.id = r.assigned_to
       WHERE r.session_id = ?
       GROUP BY u.id
       ORDER BY total_assigned DESC`,
      [req.params.id]
    );
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Drill down: every row a specific caller has handled/is handling in this session ---

router.get('/:id/callers/:userId/rows', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM call_rows WHERE session_id = ? AND assigned_to = ? ORDER BY assigned_at DESC`,
      [req.params.id, req.params.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Activate / deactivate a session ---

router.patch('/:id/status', requireAuth, requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['active', 'inactive'].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'inactive'" });
  }
  try {
    const [sessionRows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!sessionRows[0]) return res.status(404).json({ error: 'Session not found' });
    await pool.query('UPDATE sessions SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Restart a session: copy rows matching chosen dispositions into a fresh session ---

router.post('/:id/restart', requireAuth, requireAdmin, async (req, res) => {
  const { name, dispositions } = req.body;
  try {
    const [sessionRows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    const session = sessionRows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (!Array.isArray(dispositions) || dispositions.length === 0) {
      return res.status(400).json({ error: 'Choose at least one disposition to restart with' });
    }
    const chosen = dispositions.filter((d) => VALID_DISPOSITIONS.includes(d));
    if (!chosen.length) return res.status(400).json({ error: 'Invalid disposition list' });

    const placeholders = chosen.map(() => '?').join(',');
    const [sourceRows] = await pool.query(
      `SELECT * FROM call_rows WHERE session_id = ? AND status = 'done' AND disposition IN (${placeholders})
       ORDER BY row_index ASC`,
      [session.id, ...chosen]
    );

    if (!sourceRows.length) {
      return res.status(400).json({ error: 'No rows match the chosen disposition(s)' });
    }

    const newName = name && name.trim() ? name.trim() : `${session.name} (restart: ${chosen.join(', ')})`;

    const conn = await pool.getConnection();
    let newSessionId;
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        'INSERT INTO sessions (name, status, parent_session_id, filter_applied, created_by) VALUES (?, ?, ?, ?, ?)',
        [newName, 'active', session.id, chosen.join(','), req.user.id]
      );
      newSessionId = result.insertId;
      await bulkInsertRows(conn, newSessionId, 1, sourceRows, true);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const [newSessionRows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [newSessionId]);
    res.status(201).json({
      ...newSessionRows[0],
      stats: await sessionStats(newSessionId),
      imported: sourceRows.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Export a session's rows (all rows, with their current status/disposition) as excel ---

router.get('/:id/export', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sessionRows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    const session = sessionRows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const onlyDone = req.query.onlyDone === 'true';
    const [rows] = await pool.query(
      `SELECT r.*, u.name as assigned_to_name FROM call_rows r
       LEFT JOIN users u ON u.id = r.assigned_to
       WHERE r.session_id = ? ${onlyDone ? "AND r.status = 'done'" : ''}
       ORDER BY r.row_index ASC`,
      [session.id]
    );

    const buffer = buildExportExcel(rows);
    const filename = `${session.name.replace(/[^a-z0-9_\- ]/gi, '_')}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
