// ألوان السناتر والمواد: كل سنتر/مادة ليه لون بيظهر في كل القوائم (بيضوية ملونة)،
// والحصة (سنتر + مادة) بتظهر بخليط هادي من اللونين.
// اللون محفوظ في عمود color (nullable) — لو فاضي بناخد لون تلقائي ثابت من الباليتة حسب الـ id.
// القراءة بـ SQL خام ومتخزنة شوية في الذاكرة، عشان لو العمود لسه مش موجود ميوقعش أي صفحة.

const PALETTE = [
  '#6366F1', // indigo
  '#14B8A6', // teal
  '#F59E0B', // amber
  '#EC4899', // pink
  '#0EA5E9', // sky
  '#22C55E', // green
  '#8B5CF6', // violet
  '#F97316', // orange
  '#EF4444', // red
  '#06B6D4', // cyan
  '#84CC16', // lime
  '#D946EF', // fuchsia
];

const TABLES = { center: 'centers', subject: 'subjects' };
const CACHE_TTL_MS = 30 * 1000;
let cache = null;
let cacheAt = 0;
let loading = null;

function normalizeHex(value) {
  const text = String(value == null ? '' : value).trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (!m) return null;
  let hex = m[1].toLowerCase();
  if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
  return `#${hex.toUpperCase()}`;
}

// المواد بتبدأ من نص الباليتة عشان سنتر 1 ومادة 1 ميبقوش نفس اللون
function autoColor(kind, id) {
  const n = Number.parseInt(id, 10);
  if (!Number.isInteger(n) || n <= 0) return '#94A3B8';
  const offset = kind === 'subject' ? 4 : 0;
  return PALETTE[(n - 1 + offset) % PALETTE.length];
}

async function ensureColorColumns(sequelize) {
  const queryInterface = sequelize.getQueryInterface();
  for (const table of Object.values(TABLES)) {
    try {
      const info = await queryInterface.describeTable(table);
      if (!info.color) {
        await queryInterface.addColumn(table, 'color', { type: sequelize.Sequelize.STRING(7), allowNull: true, defaultValue: null });
        console.log(`✅ Added color column to ${table} table`);
      }
    } catch (error) {
      if (error.message && error.message.includes('does not exist')) continue;
      console.error(`Failed to ensure ${table}.color column:`, error.message);
    }
  }
  invalidate();
}

async function loadRows(sequelize, table) {
  try {
    const [rows] = await sequelize.query(`SELECT id, name, color FROM ${table}`);
    return rows;
  } catch (error) {
    // العمود لسه متضافش: نشتغل بالألوان التلقائية
    const [rows] = await sequelize.query(`SELECT id, name FROM ${table}`);
    return rows;
  }
}

function buildMaps(kind, rows) {
  const byId = new Map();
  const byName = new Map();
  for (const row of rows) {
    const saved = normalizeHex(row.color);
    const auto = autoColor(kind, row.id);
    const entry = { id: Number(row.id), name: row.name, saved, auto, color: saved || auto };
    byId.set(entry.id, entry);
    if (row.name != null) byName.set(String(row.name).trim(), entry);
  }
  return { byId, byName, list: [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar')) };
}

async function getColorMaps(sequelize) {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  if (!loading) {
    loading = (async () => {
      try {
        const [centers, subjects] = await Promise.all([loadRows(sequelize, TABLES.center), loadRows(sequelize, TABLES.subject)]);
        cache = { center: buildMaps('center', centers), subject: buildMaps('subject', subjects) };
        cacheAt = Date.now();
      } catch (error) {
        // القاعدة مش متاحة: نستنى شوية قبل المحاولة الجاية بدل ما كل صفحة تستنى استعلام فاشل
        if (!cache) cache = { center: buildMaps('center', []), subject: buildMaps('subject', []) };
        cacheAt = Date.now();
      } finally {
        loading = null;
      }
      return cache;
    })();
  }
  return loading;
}

function invalidate() {
  cacheAt = 0;
}

async function saveColors(sequelize, kind, colorsById) {
  const table = TABLES[kind];
  if (!table) return 0;
  let changed = 0;
  for (const [rawId, rawColor] of Object.entries(colorsById || {})) {
    const id = Number.parseInt(rawId, 10);
    if (!Number.isInteger(id) || id <= 0) continue;
    const color = rawColor === '' || rawColor == null ? null : normalizeHex(rawColor);
    if (rawColor && !color) continue;
    // updatedAt لازم يتغير عشان أجهزة الديسكتوب تاخد التعديل
    const [result] = await sequelize.query(
      `UPDATE ${table} SET color = ?, updatedAt = UTC_TIMESTAMP() WHERE id = ? AND NOT (color <=> ?)`,
      { replacements: [color, id, color] },
    );
    changed += Number(result && (result.affectedRows ?? result.changedRows)) || 0;
  }
  invalidate();
  return changed;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// helpers للـ EJS: بيقبلوا موديل (Center/Subject) أو { id, name } أو اسم بس أو id بس
function makeHelpers(maps) {
  function resolve(kind, value) {
    const m = maps[kind];
    if (value == null || value === '') return null;
    if (typeof value === 'object') {
      const id = Number(value.id ?? value.CenterId ?? value.SubjectId);
      const name = value.name;
      const hit = (Number.isInteger(id) && m.byId.get(id)) || (name != null && m.byName.get(String(name).trim()));
      if (hit) return hit;
      if (name == null) return null;
      return { id, name, color: autoColor(kind, id) };
    }
    if (typeof value === 'number' || /^\d+$/.test(String(value))) return m.byId.get(Number(value)) || null;
    return m.byName.get(String(value).trim()) || { id: null, name: String(value), color: '#94A3B8' };
  }

  function color(kind, value) {
    const hit = resolve(kind, value);
    return hit ? hit.color : '#94A3B8';
  }

  function chip(kind, value, fallback) {
    const hit = resolve(kind, value);
    if (!hit) return fallback === undefined ? '<span class="text-muted">—</span>' : escapeHtml(fallback);
    return `<span class="sf-chip sf-chip-${kind}" style="--c:${hit.color}"><i class="sf-dot"></i>${escapeHtml(hit.name)}</span>`;
  }

  function sessionParts(s) {
    if (!s) return null;
    const subject = resolve('subject', s.Subject || s.subject || s.SubjectId);
    const center = resolve('center', s.Center || s.center || s.CenterId);
    return { subject, center };
  }

  // الحصة: خليط هادي من لون المادة ولون السنتر
  function session(s, opts = {}) {
    const parts = sessionParts(s);
    if (!parts) return '<span class="text-muted">—</span>';
    const { subject, center } = parts;
    const c1 = subject ? subject.color : '#94A3B8';
    const c2 = center ? center.color : c1;
    const bits = [];
    if (subject) bits.push(escapeHtml(subject.name));
    if (center) bits.push(escapeHtml(center.name));
    let lesson = '';
    if (opts.lesson !== false && s.lesson_number != null) {
      lesson = `<b class="sf-mix-lesson"><span class="ar-only">حصة</span><span class="en-only" style="display:none;">L</span> ${escapeHtml(s.lesson_number)}</b>`;
    }
    return `<span class="sf-mix" style="--c1:${c1};--c2:${c2}"><i class="sf-mix-dot"></i>${lesson}<span class="sf-mix-text">${bits.join('<i class="sf-mix-sep">·</i>')}</span></span>`;
  }

  // attributes لـ <option> الحصة: الـ dropdown بيرسم منها صف منظم وملون
  function sessionOption(s) {
    const parts = sessionParts(s) || {};
    const attrs = {
      'data-sf-session': '1',
      'data-sf-subject': parts.subject ? parts.subject.name : '',
      'data-sf-center': parts.center ? parts.center.name : '',
      'data-sf-c1': parts.subject ? parts.subject.color : '#94A3B8',
      'data-sf-c2': parts.center ? parts.center.color : (parts.subject ? parts.subject.color : '#94A3B8'),
      'data-sf-lesson': s && s.lesson_number != null ? s.lesson_number : '',
      'data-sf-serial': s && s.serial_number != null ? s.serial_number : '',
      'data-sf-date': s && s.session_date ? String(s.session_date).slice(0, 10) : '',
      'data-sf-status': s && s.status === 'cancelled' ? 'cancelled' : '',
    };
    return Object.entries(attrs).map(([k, v]) => `${k}="${escapeHtml(v)}"`).join(' ');
  }

  // نص عادي للـ option (من غير HTML جوه الـ option)
  function sessionText(s, opts = {}) {
    const parts = sessionParts(s) || {};
    const bits = [parts.subject && parts.subject.name, parts.center && parts.center.name].filter(Boolean).join(' - ');
    const extra = [`حصة ${s.lesson_number}`];
    if (opts.serial !== false && s.serial_number != null) extra.push(`سيريال ${s.serial_number}`);
    return `${bits} (${extra.join(' | ')})`;
  }

  function colorAttr(kind, value) {
    const hit = resolve(kind, value);
    return hit ? `data-sf-color="${hit.color}"` : '';
  }

  return {
    color: (kind, value) => color(kind, value),
    center: (value, fallback) => chip('center', value, fallback),
    subject: (value, fallback) => chip('subject', value, fallback),
    session,
    sessionOption,
    sessionText,
    colorAttr,
    centers: maps.center.list,
    subjects: maps.subject.list,
  };
}

function publicColors(maps) {
  const pick = (list) => list.map(({ id, name, color }) => ({ id, name, color }));
  return { centers: pick(maps.center.list), subjects: pick(maps.subject.list) };
}

// <option> لا يقدر يعرض <span class="ar-only"> / <span class="en-only"> (المتصفح بيعرض اللغتين لازقين في بعض).
// بنحوّل الـ option لنص عربي عادي + data-sf-en فيه الإنجليزي، والصفحة بتبدّل للنص الإنجليزي لو اللغة إنجليزي.
const OPTION_RE = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
const AR_SPAN_RE = /<span class="ar-only"[^>]*>([\s\S]*?)<\/span>/gi;
const EN_SPAN_RE = /<span class="en-only"[^>]*>([\s\S]*?)<\/span>/gi;
function cleanOptionText(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
function fixOptionsInMarkup(html) {
  return html.replace(OPTION_RE, (whole, attrs, inner) => {
    if (inner.indexOf('class="ar-only"') === -1 && inner.indexOf('class="en-only"') === -1) return whole;
    const ar = cleanOptionText(inner.replace(EN_SPAN_RE, '').replace(AR_SPAN_RE, '$1'));
    const en = cleanOptionText(inner.replace(AR_SPAN_RE, '').replace(EN_SPAN_RE, '$1'));
    return `<option${attrs} data-sf-en="${en.replace(/"/g, '&quot;')}">${ar}</option>`;
  });
}
// الـ <script> و <style> بنسيبهم زي ما هم (ممكن يكون فيهم كلمة option في كومنت أو نص)
const RAW_BLOCK_RE = /(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/gi;
function fixBilingualOptions(html) {
  if (typeof html !== 'string' || html.indexOf('-only') === -1) return html;
  return html.split(RAW_BLOCK_RE).map((part, index) => (index % 2 === 1 ? part : fixOptionsInMarkup(part))).join('');
}

module.exports = {
  fixBilingualOptions,
  PALETTE,
  normalizeHex,
  autoColor,
  ensureColorColumns,
  getColorMaps,
  saveColors,
  makeHelpers,
  publicColors,
  invalidate,
};
