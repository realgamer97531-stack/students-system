# 🚀 ONLINE SESSION MIGRATION - EXECUTION GUIDE

## Overview
This migration will:
1. **Merge** center sessions (30, 38, 41, 43) with online sessions (44, 45)
2. **Migrate** all access grants from center sessions to online sessions
3. **Cancel** old center sessions (no data deletion, just status change)
4. **Audit** online student balances for duplicate payments
5. **Refund** students who paid 3+ times for what should be 2 sessions
6. **Generate** detailed reports of all changes

## Migration Configuration
```
Lesson 1 Merge:
  From: Sessions 30 (جلوري)
  To:   Session 44 (Online) - "Lecture 1 part 1"

Lesson 2 Merge:
  From: Sessions 38, 41, 43 (جلوري, اكاديمية سموحة, Physics)
  To:   Session 45 (Online) - "Lecture 1 part 2"
```

## Expected Impact
- **Online Students**: 513 students
- **Access Grants to Migrate**: ~150 (estimated)
- **Students to Audit**: 513
- **Expected Refunds**: Depends on payment history (10-50 students estimated)

## ⚠️ CRITICAL SAFETY STEPS - DO NOT SKIP

### Step 1: Create Pre-Migration Backup
```bash
node backup_pre_migration.js
```
**Status**: 🟡 Recommended before production
**Output**: `backups/pre_migration_backup_TIMESTAMP.json`

### Step 2: Run Diagnostic Report
```bash
node diagnose_sessions.js
```
**Status**: ✅ Already run - diagnostic_report_1788089815229.json generated
**Purpose**: Verify database structure

### Step 3: REVIEW THE CONFIGURATION
Before running migration, verify:
- ✅ Sessions 30, 38, 41, 43 are center sessions
- ✅ Sessions 44, 45 are online sessions
- ✅ Online content is in sessions 44 and 45
- ✅ 513 online students will be affected

### Step 4: Execute Migration (PRODUCTION SAFE)
```bash
node migrate_online_sessions.js
```

**What It Does**:
1. Loads sessions 30, 38, 41, 43, 44, 45
2. Migrates VideoAccessGrants:
   - Session 30 → Session 44 (Lesson 1)
   - Sessions 38, 41, 43 → Session 45 (Lesson 2)
3. Audits 513 online students
4. Calculates refunds for duplicate payments
5. Processes refunds by adding BalanceTransactions
6. Marks sessions 30, 38, 41, 43 as "cancelled"

**Safety Features**:
- ✅ No data deletion (only status changes to "cancelled")
- ✅ Transaction-safe operations
- ✅ Detailed logging at each step
- ✅ Full rollback information in reports
- ✅ Two backup formats: JSON (machine-readable) + TXT (human-readable)

## 📊 Expected Reports Generated

### migration_report_TIMESTAMP.json
Machine-readable complete report with:
```json
{
  "config": { /* migration configuration */ },
  "summary": {
    "sessionsMerged": 4,
    "accessGrantsMigrated": ~150,
    "onlineStudentsAudited": 513,
    "refundsIssued": 10-50,
    "totalRefundAmount": 500-2000
  },
  "sessionMerges": [ /* detailed merge info */ ],
  "accessMigrations": [ /* all 150 grants */ ],
  "balanceAudits": [ /* all 513 students */ ],
  "refunds": [ /* list of refunded students */ ],
  "errors": [ /* any errors encountered */ ]
}
```

### migration_summary_TIMESTAMP.txt
Human-readable summary for review

## ⚡ Execution Steps

```bash
# 1. Create backup (optional but RECOMMENDED)
node backup_pre_migration.js

# 2. Run migration
node migrate_online_sessions.js

# 3. Review reports
cat migration_summary_*.txt
# View detailed report in JSON:
# migration_report_*.json
```

## ✅ Verification Checklist

After migration, verify:
- [ ] All 513 online students have access to Session 44 and/or 45
- [ ] Sessions 30, 38, 41, 43 are marked as "cancelled" (not deleted)
- [ ] Students who paid for center sessions now have access to online sessions
- [ ] Refunds were issued correctly (check migration_report JSON)
- [ ] No errors in migration_summary_TIMESTAMP.txt

## 🔧 Rollback Procedure (if needed)

### If Something Goes Wrong:
1. Check `migration_error_*.json` for details
2. Sessions marked as "cancelled" can be restored with:
   ```sql
   UPDATE sessions SET status='normal' WHERE id IN (30, 38, 41, 43);
   ```
3. Access grants can be identified in migration report
4. Refund transactions can be reversed by creating negative balance transactions

### Using Backup:
```bash
# Restore from pre-migration backup
mysql -u user -p database < backups/pre_migration_backup_*.json
```

## 🎯 Expected Results

### For Online Students:
- ✅ Can access merged Lecture 1 (Session 44)
- ✅ Can access merged Lecture 2 (Session 45)
- ✅ No need to pay again for already-paid sessions
- ✅ Receive refund if they paid 3+ times

### For System:
- ✅ 4 sessions merged to 2
- ✅ ~150 access grants migrated
- ✅ 513 students audited
- ✅ Balance transactions for refunds created
- ✅ Old center sessions marked as cancelled

## 📞 Support

If something goes wrong:
1. Check migration_error_TIMESTAMP.json
2. Review the detailed report: migration_report_TIMESTAMP.json
3. Refer to ROLLBACK section above
4. Keep pre-migration backup safe

---
**Created**: 2026-08-30
**Status**: Ready for Production Execution
**Safety Level**: 🔒 High (Backup + Detailed Reporting + Rollback Capability)
