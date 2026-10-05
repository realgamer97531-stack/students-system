// سياق المزامنة المشترك بين السيرفر الأونلاين وبرنامج الديسكتوب.
// كل طلب بيتنفذ جوه "سياق" (AsyncLocalStorage) بيسجل:
//   - هل الطلب كتب في قاعدة البيانات ولا لأ (وفي أنهي جداول)
//   - الصفوف الجديدة اللي اتعملت (اسم الجدول + الـ id) بالترتيب
// وكمان لو الطلب جاي من جهاز أوفلاين (replay) بنرجّع تواريخ الصفوف الجديدة لوقت العملية الحقيقي.
// برة أي سياق (طلبات الأونلاين العادية) الكود ده مابيعملش أي حاجة.
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();
let installed = false;

const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
const WRITE_TYPES = new Set(['INSERT', 'UPDATE', 'BULKUPDATE', 'BULKDELETE', 'DELETE', 'UPSERT']);
const TABLE_IN_SQL = /^\s*(?:INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+`?([A-Za-z0-9_]+)`?/i;
// أي تاريخ اتعمل في آخر الثواني دي بنعتبره "دلوقتي" ونرجعه لوقت العملية الأصلي
const NOW_WINDOW_MS = 10 * 1000;

function current() {
  return storage.getStore() || null;
}

function run(ctx, fn) {
  return storage.run(ctx, fn);
}

function newContext(extra = {}) {
  return { wrote: false, tables: new Set(), created: [], ...extra };
}

function shiftNearNow(value, ctx) {
  if (!(value instanceof Date) || !ctx.shiftMs) return value;
  const age = Math.abs(Date.now() - value.getTime());
  if (age > NOW_WINDOW_MS) return value;
  return new Date(value.getTime() + ctx.shiftMs);
}

// بنحرك التواريخ اللي "دلوقتي" لوقت العملية الأصلي، ماعدا updatedAt:
// updatedAt لازم يفضل وقت السيرفر الحقيقي عشان باقي الأجهزة تعرف إن الصف اتغير وتنزله.
function shiftValues(values, ctx) {
  if (!values || !ctx.shiftMs) return;
  for (const key of Object.keys(values)) {
    if (key === 'updatedAt') continue;
    values[key] = shiftNearNow(values[key], ctx);
  }
}

function recordCreated(ctx, instance) {
  if (!instance || !instance.constructor || typeof instance.constructor.getTableName !== 'function') return;
  const pk = instance.constructor.primaryKeyAttribute;
  const id = pk ? instance.get(pk) : undefined;
  if (typeof id !== 'number') return;
  let table = instance.constructor.getTableName();
  if (table && typeof table === 'object') table = table.tableName;
  ctx.created.push({ table: String(table), id });
}

function install(sequelize) {
  if (installed) return;
  installed = true;

  const originalQuery = sequelize.query.bind(sequelize);
  sequelize.query = function patchedQuery(sql, options) {
    const ctx = current();
    if (ctx) {
      const text = typeof sql === 'string' ? sql : (sql && sql.query) || '';
      const type = options && options.type ? String(options.type).toUpperCase() : '';
      if (WRITE_TYPES.has(type) || WRITE_SQL.test(text)) {
        ctx.wrote = true;
        const match = TABLE_IN_SQL.exec(text);
        if (match) ctx.tables.add(match[1]);
      }
    }
    return originalQuery(sql, options);
  };

  sequelize.addHook('beforeCreate', (instance) => {
    const ctx = current();
    if (ctx && ctx.shiftMs) shiftValues(instance.dataValues, ctx);
  });
  sequelize.addHook('beforeBulkCreate', (instances) => {
    const ctx = current();
    if (!ctx || !ctx.shiftMs) return;
    for (const instance of instances) {
      const createdAtAttr = instance.constructor._timestampAttributes && instance.constructor._timestampAttributes.createdAt;
      if (createdAtAttr && !instance.dataValues[createdAtAttr]) instance.dataValues[createdAtAttr] = new Date(Date.now() + ctx.shiftMs);
      shiftValues(instance.dataValues, ctx);
    }
  });
  sequelize.addHook('beforeUpdate', (instance) => {
    const ctx = current();
    if (!ctx || !ctx.shiftMs) return;
    for (const key of instance.changed() || []) {
      if (key === 'updatedAt' || key === 'createdAt') continue;
      instance.dataValues[key] = shiftNearNow(instance.dataValues[key], ctx);
    }
  });
  sequelize.addHook('beforeBulkUpdate', (options) => {
    const ctx = current();
    if (ctx && ctx.shiftMs) shiftValues(options.attributes, ctx);
  });

  sequelize.addHook('afterCreate', (instance) => {
    const ctx = current();
    if (ctx) recordCreated(ctx, instance);
  });
  sequelize.addHook('afterBulkCreate', (instances) => {
    const ctx = current();
    if (ctx) for (const instance of instances) recordCreated(ctx, instance);
  });
}

module.exports = { install, run, current, newContext };
