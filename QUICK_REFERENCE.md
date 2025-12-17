# Inventory Auto-Sync - Quick Reference Guide

**Status**: ✅ ACTIVE
**Last Updated**: December 17, 2025

---

## 🚀 Quick Commands

### **Verify All Products**
```bash
node scripts/scan-all-products.js
```
Shows any discrepancies across all 27 products

### **Fix All Discrepancies**
```bash
node scripts/fix-all-discrepancies.js
```
Automatically corrects any found issues

### **Test Auto-Sync**
```bash
node scripts/test-auto-sync.js
```
Runs comprehensive test of the auto-sync system

### **Test Daily Continuity**
```bash
node scripts/test-daily-continuity.js
```
Verifies Opening Stock (Day N) = Closing Stock (Day N-1)

### **Check Specific Date**
```bash
node scripts/check-dec16-17-exact.js
```
Verifies opening/closing stock for specific dates

---

## 📊 System Status

### **Is Auto-Sync Running?**
Check server startup logs for:
```
✅ Inventory auto-sync cron job started (runs every 5 minutes)
```

### **How Often Does It Run?**
- **Real-time**: After every sale/purchase create/delete
- **Scheduled**: Every 5 minutes automatically

### **Where Are Corrections Logged?**
- **Console**: Server logs show corrections as they happen
- **Database**: `audit_logs` table with action `AUTO_SYNC_CORRECTION`

---

## 🔍 What to Monitor

### **Console Logs**

**Good (No Issues)**:
```
✅ Inventory sync complete: All 27 products are in sync
```

**Warning (Auto-Corrected)**:
```
⚠️  Auto-sync corrected discrepancy for 35CL BIGI: { before: 100, after: 98, diff: -2 }
```

### **Audit Logs Query**
```sql
SELECT * FROM audit_logs
WHERE action = 'AUTO_SYNC_CORRECTION'
ORDER BY created_at DESC
LIMIT 10;
```

---

## 🛠️ Troubleshooting

### **Problem**: Discrepancies keep appearing
**Solution**:
1. Run `node scripts/analyze-discrepancy-causes.js`
2. Check which products are affected
3. Review recent manual database changes

### **Problem**: Cron job not running
**Solution**:
1. Check server logs for startup message
2. Restart server: `npm run dev`
3. Verify `node-cron` is installed

### **Problem**: Need immediate sync
**Solution**:
```bash
node scripts/fix-all-discrepancies.js
```

---

## 📁 Important Files

### **Service**
- `/services/inventorySyncService.js` - Core sync logic

### **Cron Job**
- `/cron/inventorySyncCron.js` - Scheduled sync (every 5 min)

### **Integration**
- `/routes/warehouse.js` - Sale create/delete hooks
- `/routes/warehouse-purchases.js` - Purchase create/delete hooks

### **Scripts**
- `/scripts/scan-all-products.js` - Manual verification
- `/scripts/fix-all-discrepancies.js` - Manual correction
- `/scripts/test-auto-sync.js` - System test

### **Documentation**
- `/INVENTORY_AUTO_SYNC.md` - Complete guide
- `/AUTO_SYNC_DEPLOYMENT.md` - Deployment summary
- `/ROOT_CAUSE_ANALYSIS.md` - Bug history

---

## ⚡ Key Features

✅ **Self-Healing**: Automatically corrects discrepancies
✅ **Real-Time**: Syncs after every transaction
✅ **Scheduled**: Verifies every 5 minutes
✅ **Logged**: Complete audit trail
✅ **Safe**: Prevents data loss
✅ **Fast**: 2-3 seconds for 27 products

---

## 🎯 Best Practices

### **DO**
✅ Trust the auto-sync system
✅ Check audit logs weekly
✅ Run verification scripts monthly
✅ Review console logs for patterns

### **DON'T**
❌ Manually update inventory table
❌ Bypass the batch system
❌ Disable the cron job
❌ Modify batches with linked sales

---

## 📞 Quick Help

**Need to verify inventory?**
```bash
node scripts/scan-all-products.js
```

**Need to fix issues now?**
```bash
node scripts/fix-all-discrepancies.js
```

**Want to test the system?**
```bash
node scripts/test-auto-sync.js
```

---

**System Status**: ✅ ACTIVE & HEALTHY
**Current Discrepancies**: 0
**Last Verified**: 2025-12-17 13:48
