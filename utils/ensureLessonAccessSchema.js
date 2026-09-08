let ensurePromise = null;

function ensureLessonAccessSchema(sequelize) {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const [sessionColumns] = await sequelize.query("SHOW COLUMNS FROM `sessions` LIKE 'access_duration_hours'");
      if (!sessionColumns || sessionColumns.length === 0) {
        await sequelize.query("ALTER TABLE `sessions` ADD COLUMN `access_duration_hours` INT NULL");
      }

      const grantColumns = [
        ['access_started_at', 'DATETIME NULL'],
        ['access_expires_at', 'DATETIME NULL'],
        ['access_duration_hours', 'INT NULL'],
      ];

      for (const [column, definition] of grantColumns) {
        const [rows] = await sequelize.query(`SHOW COLUMNS FROM \`videoaccessgrants\` LIKE '${column}'`);
        if (!rows || rows.length === 0) {
          await sequelize.query(`ALTER TABLE \`videoaccessgrants\` ADD COLUMN \`${column}\` ${definition}`);
        }
      }
    })();
  }

  return ensurePromise;
}

module.exports = ensureLessonAccessSchema;