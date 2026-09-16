const fs = require('fs');
const mysql = require('mysql2/promise');

const dumpPath = 'C:/Users/PCM/Downloads/u135058307_student_system (1).sql';
const envPath = 'C:/Users/PCM/Desktop/student-tracking-system/.env';

function readEnv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split(/\r?\n/).reduce((acc, line) => {
    if (!line || line.trim().startsWith('#')) return acc;
    const idx = line.indexOf('=');
    if (idx >= 0) acc[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    return acc;
  }, {});
}

function splitSqlStatements(sqlText) {
  const statements = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBackticks = false;
  let escaped = false;

  for (let i = 0; i < sqlText.length; i++) {
    const ch = sqlText[i];
    const next = sqlText[i + 1];

    if (ch === '\\' && !escaped) {
      escaped = true;
      current += ch;
      continue;
    }

    if (inSingleQuote) {
      current += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "'" && next === "'") {
        current += next;
        i += 1;
        continue;
      }
      if (ch === "'") inSingleQuote = false;
      continue;
    }

    if (inDoubleQuote) {
      current += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '"' && next === '"') {
        current += next;
        i += 1;
        continue;
      }
      if (ch === '"') inDoubleQuote = false;
      continue;
    }

    if (inBackticks) {
      current += ch;
      if (ch === '`' && next === '`') {
        current += next;
        i += 1;
        continue;
      }
      if (ch === '`') inBackticks = false;
      continue;
    }

    if (ch === "'") {
      current += ch;
      inSingleQuote = true;
      escaped = false;
      continue;
    }

    if (ch === '"') {
      current += ch;
      inDoubleQuote = true;
      escaped = false;
      continue;
    }

    if (ch === '`') {
      current += ch;
      inBackticks = true;
      escaped = false;
      continue;
    }

    if (ch === ';') {
      const st = current.trim();
      if (st) statements.push(st);
      current = '';
      escaped = false;
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);

  return statements.filter((st) => /^INSERT\s+INTO\s+/i.test(st));
}

async function main() {
  const env = readEnv(envPath);
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    port: Number(env.DB_PORT || 3306),
    timezone: '+00:00',
    charset: 'utf8mb4'
  });

  const sqlText = fs.readFileSync(dumpPath, 'utf8');
  const statements = splitSqlStatements(sqlText);
  const tableNames = [...new Set(statements.map((statement) => {
    const match = statement.match(/^INSERT\s+INTO\s+`?([A-Za-z0-9_]+)`?/i);
    return match ? match[1] : null;
  }).filter(Boolean))];

  console.log(JSON.stringify({
    totalInsertStatements: statements.length,
    tablesDetected: tableNames.length,
    tableNames: tableNames.slice(0, 25)
  }, null, 2));

  const beforeCounts = {};
  for (const table of tableNames) {
    try {
      const [rows] = await conn.query(`SELECT COUNT(*) AS total FROM \`${table}\``);
      beforeCounts[table] = Number(rows[0].total);
    } catch (err) {
      beforeCounts[table] = 'unavailable';
    }
  }

  let insertedRows = 0;
  let failedStatements = 0;
  let executedStatements = 0;

  for (const statement of statements) {
    const fixedStatement = statement.replace(/^INSERT\s+INTO\s+/i, 'INSERT IGNORE INTO ');
    try {
      const [result] = await conn.execute(fixedStatement);
      executedStatements += 1;
      const affected = typeof result?.affectedRows === 'number' ? result.affectedRows : 0;
      insertedRows += affected;
    } catch (err) {
      failedStatements += 1;
      console.log('STATEMENT_FAILED', err.message);
    }
  }

  const afterCounts = {};
  for (const table of tableNames) {
    try {
      const [rows] = await conn.query(`SELECT COUNT(*) AS total FROM \`${table}\``);
      afterCounts[table] = Number(rows[0].total);
    } catch (err) {
      afterCounts[table] = 'unavailable';
    }
  }

  console.log(JSON.stringify({
    executedStatements,
    failedStatements,
    insertedRows,
    beforeCounts,
    afterCounts
  }, null, 2));

  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
