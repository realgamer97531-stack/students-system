// Extra amount charged (on top of the student's normal price_per_session) when a
// student pays from their balance to watch a specific session online.
// Applies regardless of the student's own center.
const ONLINE_SURCHARGE_RULES = [
  { subjectName: 'Math Senior 3', lessonNumber: 5, extra: 90 },
];

// Marker used on BalanceTransaction.reason so the surcharge is never applied twice
// to the same student for the same lesson (used by both the live charge and the backfill script).
function surchargeReason(rule) {
  return `رسوم إضافية مشاهدة أونلاين (${rule.subjectName} - حصة ${rule.lessonNumber})`;
}

function findSurchargeRule(subjectName, lessonNumber) {
  return ONLINE_SURCHARGE_RULES.find(
    rule => rule.subjectName === subjectName && rule.lessonNumber === Number(lessonNumber)
  ) || null;
}

module.exports = { ONLINE_SURCHARGE_RULES, surchargeReason, findSurchargeRule };
