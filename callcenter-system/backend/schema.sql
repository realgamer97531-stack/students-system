-- Call Center Console — MySQL schema
--
-- The backend actually creates these tables automatically on startup, so
-- you don't strictly have to run this by hand. But if you'd rather set it
-- up yourself in phpMyAdmin first (or your Hostinger DB user doesn't have
-- CREATE TABLE rights for some reason), paste this whole file into
-- phpMyAdmin → your database → SQL tab → Go.

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS call_rows (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  row_index INT NOT NULL,
  student_id VARCHAR(100),
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  parent_phone VARCHAR(50),
  grade VARCHAR(100),
  subject VARCHAR(100),
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
) ENGINE=InnoDB;
