require('dotenv').config();
const sequelize = require('../config/database');
const StudentBooklet = require('../models/StudentBooklet');

async function main() {
  try {
    await sequelize.authenticate();

    const rows = await StudentBooklet.findAll({
      attributes: ['id', 'paid_amount', 'custom_price'],
    });

    let updated = 0;
    for (const row of rows) {
      const current = Number(row.custom_price ?? 0);
      if (!Number.isFinite(current) || current === 350) continue;

      row.custom_price = 350;
      await row.save();
      updated += 1;
    }

    console.log(`✅ تم تحديث سعر البوكليت لكل طالب إلى 350. عدد السجلات المعدلة: ${updated}`);
    console.log(`💵 تم الحفاظ على paid_amount كما هو دون أي تعديل.`);
  } catch (error) {
    console.error('❌ فشل تحديث أسعار البوكليت:', error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

main();
