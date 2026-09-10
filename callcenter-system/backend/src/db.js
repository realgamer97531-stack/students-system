const mysql = require('mysql2/promise');
require('dotenv').config();

// Table is named call_rows (not "rows") because ROWS became a reserved
// keyword in modern MySQL — avoids any risk of syntax conflicts.
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

async function initSchema() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        parent_session_id INT NULL,
        filter_applied VARCHAR(255),
        created_by INT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (parent_session_id) REFERENCES sessions(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS call_rows (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        row_index INT NOT NULL,
        student_id VARCHAR(100),
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        parent_phone VARCHAR(50),
        center VARCHAR(100),
        grade VARCHAR(100),
        subject VARCHAR(100),
        homework_status VARCHAR(50),
        exam_score DECIMAL(10,2) NULL,
        exam_max DECIMAL(10,2) NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        assigned_to INT NULL,
        assigned_at DATETIME NULL,
        disposition VARCHAR(30) NULL,
        comment TEXT NULL,
        completed_at DATETIME NULL,
        source_row_id INT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (assigned_to) REFERENCES users(id),
        FOREIGN KEY (source_row_id) REFERENCES call_rows(id),
        INDEX idx_rows_session_status (session_id, status),
        INDEX idx_rows_assigned (session_id, assigned_to, status)
      ) ENGINE=InnoDB
    `);

    // Migration: databases created before the comment column existed won't
    // have it yet — add it in place so nobody has to drop/recreate tables.
    const [existingCols] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'call_rows' AND COLUMN_NAME = 'comment'`
    );
    if (existingCols.length === 0) {
      await conn.query('ALTER TABLE call_rows ADD COLUMN comment TEXT NULL');
    }

    const [rowColumns] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'call_rows'`
    );
    const existingColumnNames = new Set(rowColumns.map((column) => column.COLUMN_NAME));
    const migrations = [
      ['center', 'VARCHAR(100) NULL'],
      ['homework_status', 'VARCHAR(50) NULL'],
      ['exam_score', 'DECIMAL(10,2) NULL'],
      ['exam_max', 'DECIMAL(10,2) NULL'],
    ];
    for (const [column, definition] of migrations) {
      if (!existingColumnNames.has(column)) {
        await conn.query(`ALTER TABLE call_rows ADD COLUMN ${column} ${definition}`);
      }
    }
  } finally {
    conn.release();
  }
}

module.exports = { pool, initSchema };
