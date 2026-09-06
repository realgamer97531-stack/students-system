const XLSX = require('xlsx');

// Column headers can be customized per-deployment via .env (e.g. if your
// files use "Student Code" instead of "Student ID"). Whatever you set there
// is matched in ADDITION to the common defaults below, case-insensitively.
function envSynonym(key) {
  const val = process.env[key];
  return val ? [normalizeHeader(val)] : [];
}

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildColumnMap() {
  return {
    student_id: [...envSynonym('COLUMN_HEADER_STUDENT_ID'), 'student id', 'id', 'student_id', 'code'],
    name: [...envSynonym('COLUMN_HEADER_NAME'), 'name', 'student name', 'student'],
    phone: [...envSynonym('COLUMN_HEADER_PHONE'), 'phone', 'student phone', 'phone number'],
    parent_phone: [
      ...envSynonym('COLUMN_HEADER_PARENT_PHONE'),
      'parent phone', 'parent number', 'guardian phone', 'parentphone',
    ],
    grade: [...envSynonym('COLUMN_HEADER_GRADE'), 'grade', 'grade level', 'class'],
    subject: [...envSynonym('COLUMN_HEADER_SUBJECT'), 'subject', 'course'],
  };
}

// Only Name has to be present in the file. Everything else is optional —
// if a column is missing, that field is simply left blank for every row.
const REQUIRED_FIELDS = ['name'];

function buildHeaderIndex(headerRow) {
  const index = {};
  headerRow.forEach((raw, i) => {
    index[normalizeHeader(raw)] = i;
  });
  const columnMap = buildColumnMap();
  const resolved = {};
  const missing = [];
  for (const [field, synonyms] of Object.entries(columnMap)) {
    const found = synonyms.find((s) => index[s] !== undefined);
    if (found === undefined) {
      if (REQUIRED_FIELDS.includes(field)) missing.push(field);
    } else {
      resolved[field] = index[found];
    }
  }
  return { resolved, missing };
}

function cell(row, idx) {
  return idx === undefined ? '' : String(row[idx] ?? '').trim();
}

/**
 * Normalise a phone number from an Excel cell so it always starts with 0.
 * Examples:
 *   "1282890717"  → "01282890717"
 *   "01282890717" → "01282890717"  (unchanged)
 *   "+201282890717" → "+201282890717"  (already has country code, leave it)
 *   ""  → ""
 */
function normalisePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // Already has a + country code — leave exactly as-is.
  if (s.startsWith('+')) return s;
  // Strip any non-digit characters (spaces, dashes, etc.)
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  // Already starts with 0 — fine.
  if (digits.startsWith('0')) return digits;
  // Starts with 20 (Egypt country code without +) — add the leading 0 so
  // the local format is preserved: 201282890717 → 01282890717.
  // Actually we keep the full number; the WhatsApp helper on the frontend
  // will add 20 back for wa.me links. So we just ensure a leading 0.
  // If the number is 10 digits starting with 1 it's a local Egyptian number
  // missing the leading 0.
  return '0' + digits;
}


/**
 * { student_id, name, phone, parent_phone, grade, subject } objects.
 * Only "Name" is required; missing optional columns are left blank.
 * Throws an Error with a helpful message if "Name" itself is missing.
 */
function parseStudentsExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  if (!rows.length) throw new Error('The uploaded file is empty.');

  const headerRow = rows[0];
  const { resolved, missing } = buildHeaderIndex(headerRow);

  if (missing.length) {
    throw new Error(
      `Missing required column(s): ${missing.join(', ')}. ` +
      `A "Name" column is required; Student ID, Phone, Parent Phone, Grade, and Subject are optional.`
    );
  }

  const students = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => String(c).trim() === '')) continue; // skip blank rows
    const name = cell(row, resolved.name);
    if (!name) continue; // a row without a name is not a usable record
    students.push({
      student_id: cell(row, resolved.student_id),
      name,
      phone:        normalisePhone(cell(row, resolved.phone)),
      parent_phone: normalisePhone(cell(row, resolved.parent_phone)),
      grade:   cell(row, resolved.grade),
      subject: cell(row, resolved.subject),
    });
  }

  if (!students.length) throw new Error('No usable data rows were found in the file.');
  return students;
}

/**
 * Builds an .xlsx buffer from an array of row objects (as returned by the DB).
 */
function buildExportExcel(rowsData) {
  const data = rowsData.map((r) => ({
    'Student ID': r.student_id || '',
    Name: r.name,
    Phone: r.phone,
    'Parent Phone': r.parent_phone,
    Grade: r.grade,
    Subject: r.subject,
    Status: r.status,
    Disposition: r.disposition || '',
    Comment: r.comment || '',
    'Assigned To': r.assigned_to_name || '',
    'Assigned At': r.assigned_at || '',
    'Completed At': r.completed_at || '',
  }));
  const sheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Results');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { parseStudentsExcel, buildExportExcel };
