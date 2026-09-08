const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const VALID_DISPOSITIONS = ['no_answer', 'busy', 'wrong_number', 'follow_up', 'rejected', 'skipped', 'deal_done'];

/*
 * ATOMICITY NOTE:
 * This runs inside a single MySQL/InnoDB transaction using SELECT ... FOR
 * UPDATE, which takes a row-level lock. If two callers request "next" for
 * the same session at nearly the same instant, the second transaction's
 * FOR UPDATE simply blocks until the first one commits — and a locking
 * read like this always re-checks against the latest committed data (not
 * a stale snapshot), so once the first row flips to "assigned" the second
 * transaction correctly skips it and finds the next real pending row.
 * That's what guarantees no two callers are ever handed the same row.
 */
async function claimNextRow(sessionId, userId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // If this caller already has an unfinished row in this session, hand it
    // back instead of assigning a new one (safe to call /next again after a
    // page refresh without losing or skipping a row).
    const [existing] = await conn.query(
      `SELECT * FROM call_rows WHERE session_id = ? AND assigned_to = ? AND status = 'assigned' LIMIT 1 FOR UPDATE`,
      [sessionId, userId]
    );
    if (existing.length) {
      await conn.commit();
      return { row: existing[0], resumed: true };
    }

    const [pending] = await conn.query(
      `SELECT id FROM call_rows WHERE session_id = ? AND status = 'pending' ORDER BY row_index ASC LIMIT 1 FOR UPDATE`,
      [sessionId]
    );
    if (!pending.length) {
      await conn.commit();
      return { row: null, resumed: false };
    }

    const rowId = pending[0].id;
    await conn.query(
      `UPDATE call_rows SET status = 'assigned', assigned_to = ?, assigned_at = NOW() WHERE id = ? AND status = 'pending'`,
      [userId, rowId]
    );
    const [rows] = await conn.query('SELECT * FROM call_rows WHERE id = ?', [rowId]);
    await conn.commit();
    return { row: rows[0], resumed: false };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// --- Caller requests the next available row in a session ---

router.post('/sessions/:id/next', requireAuth, async (req, res) => {
  try {
    const [sessionRows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    const session = sessionRows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'active') {
      return res.status(400).json({ error: 'This session is not active' });
    }

    const { row, resumed } = await claimNextRow(session.id, req.user.id);

    if (!row) {
      const [stats] = await pool.query(
        `SELECT status, COUNT(*) as c FROM call_rows WHERE session_id = ? GROUP BY status`,
        [session.id]
      );
      return res.json({ row: null, done: true, stats });
    }

    res.json({ row, resumed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Caller explicitly skips their current row (no disposition saved) ---
// Used by the "Next" button when the comment box is empty.
router.post('/rows/:id/release-own', requireAuth, async (req, res) => {
  try {
    const [rowsRes] = await pool.query('SELECT * FROM call_rows WHERE id = ?', [req.params.id]);
    const row = rowsRes[0];
    if (!row) return res.status(404).json({ error: 'Row not found' });
    if (row.status !== 'assigned' || row.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'This row is not currently assigned to you' });
    }
    await pool.query(
      `UPDATE call_rows SET status = 'pending', assigned_to = NULL, assigned_at = NULL WHERE id = ?`,
      [row.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Release the current row and atomically claim the next different row.
router.post('/rows/:id/release-own-next', requireAuth, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [currentRows] = await conn.query(
      'SELECT * FROM call_rows WHERE id = ? FOR UPDATE',
      [req.params.id]
    );
    const currentRow = currentRows[0];
    if (!currentRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'Row not found' });
    }
    if (currentRow.status !== 'assigned' || currentRow.assigned_to !== req.user.id) {
      await conn.rollback();
      return res.status(403).json({ error: 'This row is not currently assigned to you' });
    }

    await conn.query(
      `UPDATE call_rows SET status = 'pending', assigned_to = NULL, assigned_at = NULL WHERE id = ?`,
      [currentRow.id]
    );

    const [pending] = await conn.query(
      `SELECT id FROM call_rows
       WHERE session_id = ? AND status = 'pending' AND id <> ?
       ORDER BY row_index ASC LIMIT 1 FOR UPDATE`,
      [currentRow.session_id, currentRow.id]
    );

    if (!pending.length) {
      await conn.commit();
      return res.json({ row: null, done: true });
    }

    const nextId = pending[0].id;
    await conn.query(
      `UPDATE call_rows SET status = 'assigned', assigned_to = ?, assigned_at = NOW()
       WHERE id = ? AND status = 'pending'`,
      [req.user.id, nextId]
    );
    const [nextRows] = await conn.query('SELECT * FROM call_rows WHERE id = ?', [nextId]);
    await conn.commit();
    res.json({ row: nextRows[0], resumed: false });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// --- Caller submits a disposition, finalizing their current row ---

router.post('/rows/:id/disposition', requireAuth, async (req, res) => {
  const { disposition, comment } = req.body;
  if (!VALID_DISPOSITIONS.includes(disposition)) {
    return res.status(400).json({ error: 'Invalid disposition value' });
  }

  try {
    const [rowsRes] = await pool.query('SELECT * FROM call_rows WHERE id = ?', [req.params.id]);
    const row = rowsRes[0];
    if (!row) return res.status(404).json({ error: 'Row not found' });
    if (row.status !== 'assigned' || row.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'This row is not currently assigned to you' });
    }

    await pool.query(
      `UPDATE call_rows SET status = 'done', disposition = ?, comment = ?, completed_at = NOW() WHERE id = ?`,
      [disposition, comment && comment.trim() ? comment.trim() : null, row.id]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
