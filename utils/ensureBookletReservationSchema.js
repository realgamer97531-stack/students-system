let ensurePromise = null;

function ensureBookletReservationSchema(sequelize) {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const [rows] = await sequelize.query("SHOW COLUMNS FROM `BookletReservations` LIKE 'transaction_reference'");
      if (!rows || rows.length === 0) {
        await sequelize.query("ALTER TABLE `BookletReservations` ADD COLUMN `transaction_reference` VARCHAR(255) NULL UNIQUE");
      }
    })();
  }

  return ensurePromise;
}

module.exports = ensureBookletReservationSchema;