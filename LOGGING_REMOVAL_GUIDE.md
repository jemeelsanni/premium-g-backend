# LOGGING REDUCTION - QUICK REFERENCE GUIDE

## CRITICAL REMOVALS (HIGHEST IMPACT)

### 1. Warehouse Discounts Function - 13 logs per sale
**File**: `/home/user/premium-g-backend/routes/warehouse-discounts.js`
**Lines**: 320-453 (entire `checkCustomerDiscount()` function)
**Current**: 13 console.log statements per call
**Impact**: Called on EVERY warehouse sale
**Action**: Remove ALL logging from this function

```javascript
// REMOVE THESE LINES:
320  console.log('🔍 ===== DISCOUNT CHECK START =====');
321  console.log('🔍 Input params:', {...});
353  console.log('🔍 Product-specific discount query result:', ...);
380  console.log('🔍 General discount query result:', ...);
383  console.log('🔍 Best discount selected:', ...);
386  console.log('❌ No discount found in database');
387  console.log('🔍 ===== DISCOUNT CHECK END =====');
399  console.log('❌ Minimum quantity not met:', {...});
403  console.log('🔍 ===== DISCOUNT CHECK END =====');
415  console.log('❌ Discount expired:', {...});
419  console.log('🔍 ===== DISCOUNT CHECK END =====');
445  console.log('✅ Discount calculated successfully:', {...});
453  console.log('🔍 ===== DISCOUNT CHECK END =====');
```

**Estimate Impact**: 1,000+ logs/day reduced

---

### 2. Warehouse Inventory Response Logging
**File**: `/home/user/premium-g-backend/routes/warehouse.js`
**Line**: 297
**Current**: Logs entire inventory array with JSON.stringify
**Action**: Remove this line

```javascript
// REMOVE:
297  console.log('📤 SENDING RESPONSE:', JSON.stringify(formattedInventory, null, 2));
```

**Estimate Impact**: 100-200 logs/day (potentially multi-KB entries)

---

### 3. Payment Input/Output Logging
**File**: `/home/user/premium-g-backend/routes/warehouse.js`
**Lines**: 562, 580, 665
**Current**: Logs raw payment input, cleaned amounts, and payment summary
**Action**: Remove these lines (sensitive data)

```javascript
// REMOVE:
562  console.log('📥 RAW INPUT:', { providedAmountPaid, paymentMethod, initialPaymentMethod });
580  console.log('✅ CLEANED amountPaid:', amountPaid);
665  console.log('💰 PAYMENT SUMMARY:', { totalAmount, amountPaid, balance: totalAmount - amountPaid });
```

**Estimate Impact**: 100-200 logs/day (sensitive transaction data)

---

## HIGH PRIORITY REMOVALS

### 4. Module Loading Debug Logs
**File**: `/home/user/premium-g-backend/routes/warehouse.js`
**Lines**: 37-68
**Current**: 5 logs during module initialization
**Action**: Remove or comment out

```javascript
// REMOVE:
37   console.log('🔍 Warehouse discounts module structure:', {...});
47   console.log('✅ Warehouse discounts router and function loaded successfully');
54   console.log('✅ Warehouse discounts function loaded successfully');
58   console.log('⚠️  checkCustomerDiscount function not found, using fallback');
68   console.log('⚠️  Warehouse discounts router not found, skipping...', error.message);
```

**Estimate Impact**: 5 logs at startup only

---

### 5. Inventory Calculation Debug Logs
**File**: `/home/user/premium-g-backend/routes/warehouse.js`
**Lines**: 253-272
**Current**: Per-item diagnostic logging
**Action**: Remove

```javascript
// REMOVE:
253  console.log('📦 INVENTORY ITEM DEBUG:', {
  // ... entire debug block ...
272  });
```

**Estimate Impact**: Logs per inventory item (100+ logs/day potentially)

---

### 6. FEFO Allocation Logging
**File**: `/home/user/premium-g-backend/routes/warehouse.js`
**Lines**: 695-699
**Current**: Logs batch allocations per sale
**Action**: Remove or make conditional on log level

```javascript
// REMOVE or MAKE CONDITIONAL:
695  console.log('📦 FEFO Allocations:', batchAllocations.map(b => ({
  batch: b.batchNumber,
  qty: b.quantityAllocated,
  expiry: b.expiryDate
})));
```

**Estimate Impact**: 100+ logs/day

---

### 7. Batch Allocation Invalid Cost Logging
**File**: `/home/user/premium-g-backend/routes/warehouse.js`
**Line**: 708
**Current**: Error logging during cost calculation
**Action**: Remove (should be handled by error middleware)

```javascript
// REMOVE:
708  console.error('❌ Invalid cost calculation:', {...});
```

**Estimate Impact**: Rare/error cases only

---

### 8. Sale Transaction Completion Log
**File**: `/home/user/premium-g-backend/routes/warehouse.js`
**Line**: 879
**Current**: Transaction completion status
**Action**: Remove

```javascript
// REMOVE:
879  console.log('✅✅✅ Transaction completed successfully');
```

**Estimate Impact**: 100+ logs/day

---

## MEDIUM PRIORITY REMOVALS

### 9. Distribution Order Creation Logging
**File**: `/home/user/premium-g-backend/routes/distribution.js`
**Lines**: 316, 346, 348, 491, 513
**Current**: Multiple debug logs throughout order creation
**Action**: Remove or consolidate

```javascript
// REMOVE:
316  console.log('📦 Received order data:', { customerId, locationId, deliveryLocation, orderItems });
346  console.log('✅ Created new location:', location.name);
348  console.log('✅ Found existing location:', location.name);
491  console.log('⚠️ Weekly performance update skipped:', error.message);
513  console.log('✅ Order created successfully:', order.id);
```

**Estimate Impact**: 50-100 logs/day

---

### 10. Distribution Analytics Debug
**File**: `/home/user/premium-g-backend/routes/distribution.js`
**Line**: 1417
**Current**: Dashboard analytics debug logging
**Action**: Remove

```javascript
// REMOVE or INVESTIGATE:
1417 console.log('Dashboard Analytics DEBUG:', {...});
```

---

### 11. Transport Cash Flow Logging
**File**: `/home/user/premium-g-backend/routes/transport.js`
**Lines**: 300, 1077, 1231
**Current**: Cash flow entry creation logs
**Action**: Reduce frequency or remove

```javascript
// REMOVE/REDUCE:
300  console.log('✅ Transport order & cash flow entries created:', {...});
1077 console.log('✅ Cash flow entry created for approved transport expense:', {...});
1231 console.log(`✅ Created ${cashFlowEntries.length} cash flow entries for bulk approved transport expenses`);
```

**Estimate Impact**: 20-50 logs/day

---

### 12. Warehouse Expense Logging
**File**: `/home/user/premium-g-backend/routes/warehouse-expenses.js`
**Lines**: 313, 414
**Current**: Expense approval and bulk approval logs
**Action**: Remove or reduce

```javascript
// REMOVE/REDUCE:
313  console.log('✅ Cash flow entry created for approved expense:', {...});
414  console.log(`✅ Created ${cashFlowEntries.length} cash flow entries for bulk approved expenses`);
```

---

### 13. Warehouse Debtor Payment Logging
**File**: `/home/user/premium-g-backend/routes/warehouse-debtors.js`
**Lines**: 330, 352
**Current**: Payment status and cash flow logging
**Action**: Remove or reduce

```javascript
// REMOVE:
330  console.log('✅ Warehouse sale payment status updated:', {...});
352  console.log('✅ Cash flow entry created for debt payment:', {...});
```

---

### 14. Warehouse Purchase Logging
**File**: `/home/user/premium-g-backend/routes/warehouse-purchases.js`
**Line**: 177
**Current**: Cash flow entry creation log
**Action**: Remove

```javascript
// REMOVE:
177  console.log('✅ Cash flow entry created for purchase:', {...});
```

---

## MODERATE PRIORITY (CRON JOBS - Can keep but reduce verbosity)

### 15. Batch Status Manager Logging
**File**: `/home/user/premium-g-backend/jobs/batch-status-manager.js`
**Lines**: 28, 47, 77-81, 94, 108, 112
**Current**: 8 logs per daily cron job
**Impact**: Daily execution (1x per day) = lower impact
**Action**: Consolidate into fewer logs

```javascript
// REDUCE (not critical, runs daily):
28   console.log(`✅ Marked ${result.count} batches as EXPIRED`);
47   console.log(`✅ Marked ${result.count} batches as DEPLETED`);
77   console.log(`⚠️  CRITICAL: ${criticalBatches.length} batches expiring within 7 days`);
78-81 criticalBatches.forEach(batch => console.log(...)); // Replace with single summary
94   console.log('🔄 Starting batch status management job...');
108  console.log('✅ Batch status management completed:', summary);
112  console.error('❌ Batch status management failed:', error);
```

**Recommendation**: Keep 1-2 summary logs instead of per-item

---

## SERVER STARTUP LOGGING (Can keep or reduce)

### 16. Server Startup Logging
**File**: `/home/user/premium-g-backend/server.js`
**Lines**: 318, 328, 332, 339, 344, 492-507, 512-515, 521-524
**Current**: Startup and cron job logging
**Impact**: Once at startup, acceptable for production
**Action**: Keep essential info (startup message), remove verbose details

```javascript
// KEEP (essential):
492-507  Server startup banner

// REDUCE:
318  console.error('System status error:', error);  // Keep as error
328  console.log('🕐 Running scheduled batch status management...');  // Remove emoji
332  console.error('❌ Scheduled job failed:', error);  // Keep as error
339  console.log('🚀 Running initial batch status check...');  // Remove emoji
344  console.log('✅ Batch status management cron job scheduled');  // Remove emoji
512-515 Graceful shutdown logs - keep these (important)
521-524 SIGINT shutdown logs - keep these (important)
```

---

## ACCEPTABLE LOGGING (No action needed)

### Seed & Utility Scripts
- `/prisma/seed.js` - 24 logs (only runs during setup, acceptable)
- `/prisma/clear-db.js` - 16 logs (only runs during cleanup, acceptable)
- `/scripts/update-cash-flow-modules.js` - 7 logs (migration script, acceptable)

### Error Handler
- `/middleware/errorHandler.js:8` - Error logging (essential, keep)

### Middleware
- `/middleware/auth.js:142` - Auth errors (important, keep)
- `/middleware/auditLogger.js:80, 106, 129` - Audit errors (important, keep)

### Morgan HTTP Logging
- `/server.js:115` - Morgan middleware (essential, keep)

---

## SUMMARY OF CHANGES

| Category | Count | Action | Impact |
|----------|-------|--------|--------|
| **CRITICAL** | 3 files | Remove entirely | 1,500+ logs/day |
| **HIGH** | 5 files | Remove entirely | 300+ logs/day |
| **MEDIUM** | 3 files | Remove/Reduce | 100+ logs/day |
| **CRON JOBS** | 1 file | Consolidate | 8 to 2-3 logs/day |
| **STARTUP** | Various | Keep or Reduce | No runtime impact |
| **TOTAL** | ~40 locations | Clean up | 1,900+ logs/day reduction |

---

## IMPLEMENTATION PRIORITY

### Phase 1 (Immediate - Highest ROI)
1. warehouse-discounts.js: Remove 13 logs from checkCustomerDiscount()
2. warehouse.js:297: Remove JSON.stringify response logging
3. warehouse.js:562,580,665: Remove payment logging

**Estimated reduction**: 1,200+ logs/day

### Phase 2 (Quick wins)
4. warehouse.js:37-68: Remove module loading debug
5. warehouse.js:253-272: Remove inventory calculation debug
6. distribution.js: Remove order creation logs

**Estimated reduction**: 200+ logs/day

### Phase 3 (Housekeeping)
7. transport.js, warehouse-expenses.js, warehouse-debtors.js: Remove/reduce transaction logs
8. batch-status-manager.js: Consolidate cron logs
9. server.js: Remove emoji from startup logs

**Estimated reduction**: 100+ logs/day

---

## TOTAL REDUCTION
From ~1,500-2,000+ logs/day to ~300 essential logs/day (80-85% reduction)

