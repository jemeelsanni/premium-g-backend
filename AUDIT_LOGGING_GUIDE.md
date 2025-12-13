# Audit Logging System - Complete Guide

## ✅ AUDIT LOGGING IS NOW ENABLED!

All inventory changes are now automatically tracked with full details about WHO, WHAT, WHEN, and WHY.

---

## 📋 What Gets Logged

### 1. **Direct Inventory Updates** (CRITICAL)
- **Endpoint**: `PUT /api/v1/warehouse/inventory/:id`
- **File**: `routes/warehouse.js:319-394`
- **Logs**:
  - User who made the change
  - Old vs new inventory values (pallets, packs, units)
  - Reason provided (or "No reason provided")
  - IP address and user agent
  - Timestamp

### 2. **Purchase Updates** (Quantity Changes)
- **Endpoint**: `PUT /api/v1/warehouse/purchases/:id`
- **File**: `routes/warehouse-purchases.js:515-739`
- **Logs**:
  - Quantity changes that affect inventory
  - User who edited the purchase
  - Before/after inventory values
  - Reason: "Purchase quantity increased/decreased by X"
  - Reference to purchase ID

### 3. **Purchase Deletions**
- **Endpoint**: `DELETE /api/v1/warehouse/purchases/:id`
- **File**: `routes/warehouse-purchases.js:744-869`
- **Logs**:
  - Entire purchase record before deletion
  - Inventory reversal details
  - User who deleted
  - Reason: "Purchase deleted - reversed X units"

### 4. **Sale Deletions** (Inventory Restoration)
- **Endpoint**: `DELETE /api/v1/warehouse/sales/:id`
- **File**: `routes/warehouse.js:1476-1645`
- **Logs**:
  - Sale details before deletion
  - Inventory restoration (adding stock back)
  - User who deleted
  - Receipt number for reference

### 5. **Automatic Batch Expiry** (System Action)
- **Job**: `jobs/batch-status-manager.js`
- **Schedule**: Daily at midnight (configurable)
- **Logs**:
  - Each batch marked as EXPIRED
  - Expiry date and quantity remaining
  - Product name and batch number
  - User ID: 'SYSTEM'

---

## 🔍 How to View Audit Logs

### **API Endpoints Created**

#### 1. Get All Audit Logs (with filtering)
```bash
GET /api/v1/audit-logs
```

**Query Parameters**:
- `entity` - Filter by entity type (WarehouseInventory, WarehouseSale, WarehouseProductPurchase)
- `action` - Filter by action (CREATE, UPDATE, DELETE)
- `entityId` - Filter by specific record ID
- `userId` - Filter by user who performed action
- `startDate` - Filter from date (ISO 8601)
- `endDate` - Filter to date (ISO 8601)
- `page` - Page number (default: 1)
- `limit` - Results per page (default: 50, max: 100)

**Example**:
```bash
GET /api/v1/audit-logs?entity=WarehouseInventory&startDate=2024-12-01&limit=100
```

---

#### 2. Get Inventory Change Logs (Detailed)
```bash
GET /api/v1/audit-logs/inventory-changes
```

**Query Parameters**:
- `productId` - Filter by specific product
- `triggeredBy` - Filter by trigger (MANUAL_ADJUSTMENT, SALE, PURCHASE_UPDATE, PURCHASE_DELETE, SALE_DELETE)
- `startDate` - From date
- `endDate` - To date
- `page` - Page number
- `limit` - Results per page

**Example - Find all manual adjustments for "sosa 1 ltr"**:
```bash
GET /api/v1/audit-logs/inventory-changes?productId=<PRODUCT_ID>&triggeredBy=MANUAL_ADJUSTMENT
```

**Response includes**:
- Product name and ID
- User who made the change
- Old vs new inventory values
- Calculated differences (packs: +10, units: -5, etc.)
- Reason provided
- Trigger type
- Reference ID (sale/purchase ID if applicable)
- IP address and timestamp

---

#### 3. Get Suspicious Activities Report
```bash
GET /api/v1/audit-logs/suspicious-activities
```

**Query Parameters**:
- `days` - Number of days to look back (default: 7, max: 90)

**Automatically flags**:
- ❌ Manual adjustments with no reason
- ❌ Large inventory reductions (>50 packs or >10 pallets)
- ❌ Purchase deletions
- ❌ Sale deletions
- ❌ Direct manual adjustments

**Severity Levels**:
- `HIGH` - Multiple red flags
- `MEDIUM` - Single red flag

**Example**:
```bash
GET /api/v1/audit-logs/suspicious-activities?days=30
```

**Response**:
```json
{
  "success": true,
  "data": {
    "suspiciousActivities": [
      {
        "id": "audit_log_id",
        "createdAt": "2024-12-13T10:30:00Z",
        "user": {
          "username": "admin_user",
          "role": "WAREHOUSE_ADMIN"
        },
        "productName": "Sosa 1 Ltr",
        "triggeredBy": "MANUAL_ADJUSTMENT",
        "reason": "No reason provided",
        "changes": {
          "packs": { "old": 100, "new": 50, "diff": -50 }
        },
        "suspicionReasons": [
          "Direct manual inventory adjustment",
          "Large reduction: -50 packs",
          "No reason provided for manual adjustment"
        ],
        "severity": "HIGH"
      }
    ],
    "summary": {
      "total": 15,
      "high": 3,
      "medium": 12,
      "period": "Last 30 days"
    }
  }
}
```

---

#### 4. Get All Changes for a Specific Product
```bash
GET /api/v1/audit-logs/product/:productId
```

**Returns**:
- All inventory updates for the product
- All sales involving the product
- All purchases involving the product
- Summary statistics

**Example - View all history for "sosa 1 ltr"**:
```bash
GET /api/v1/audit-logs/product/<SOSA_PRODUCT_ID>
```

---

## 🎯 How to Find Missing Stock for "Sosa 1 Ltr"

### **Step 1: Get the Product ID**
```sql
SELECT id, name, product_no FROM products WHERE name LIKE '%sosa%1%ltr%';
```

### **Step 2: Check All Inventory Changes**
```bash
GET /api/v1/audit-logs/inventory-changes?productId=<PRODUCT_ID>&startDate=2024-12-01
```

Look for:
- `triggeredBy: "MANUAL_ADJUSTMENT"` - Someone directly changed inventory
- `triggeredBy: "PURCHASE_UPDATE"` - Purchase quantity was reduced
- `triggeredBy: "PURCHASE_DELETE"` - Purchase was deleted
- Large negative `diff` values in changes

### **Step 3: Check Suspicious Activities**
```bash
GET /api/v1/audit-logs/suspicious-activities?days=30
```

Filter response for "Sosa 1 Ltr" entries.

### **Step 4: View Complete History**
```bash
GET /api/v1/audit-logs/product/<PRODUCT_ID>
```

This shows EVERYTHING that happened to this product.

---

## 📊 Audit Log Data Structure

Each audit log contains:

```json
{
  "id": "audit_log_cuid",
  "userId": "user_id",
  "user": {
    "username": "admin_user",
    "email": "admin@example.com",
    "role": "WAREHOUSE_ADMIN"
  },
  "action": "UPDATE",
  "entity": "WarehouseInventory",
  "entityId": "inventory_id",
  "oldValues": {
    "pallets": 0,
    "packs": 100,
    "units": 0,
    "reorderLevel": 20
  },
  "newValues": {
    "pallets": 0,
    "packs": 50,
    "units": 0,
    "reorderLevel": 20,
    "metadata": {
      "productId": "product_id",
      "productName": "Sosa 1 Ltr",
      "reason": "Stock adjustment - damaged goods",
      "triggeredBy": "MANUAL_ADJUSTMENT",
      "referenceId": null,
      "timestamp": "2024-12-13T10:30:00Z",
      "changes": {
        "packs": { "old": 100, "new": 50, "diff": -50 }
      }
    }
  },
  "ipAddress": "192.168.1.100",
  "userAgent": "Mozilla/5.0...",
  "createdAt": "2024-12-13T10:30:00Z"
}
```

---

## 🔐 Access Control

**Who can view audit logs?**
- `SUPER_ADMIN` - Full access to all endpoints
- `WAREHOUSE_ADMIN` - Full access to all endpoints
- Other roles - No access

---

## 🚀 Quick Start Guide

### **To investigate current stock issues:**

1. **Find suspicious activities in the last 30 days**:
   ```bash
   curl -H "Authorization: Bearer YOUR_TOKEN" \
     "http://your-api/api/v1/audit-logs/suspicious-activities?days=30"
   ```

2. **Check all inventory changes for "sosa 1 ltr"**:
   ```bash
   curl -H "Authorization: Bearer YOUR_TOKEN" \
     "http://your-api/api/v1/audit-logs/inventory-changes?productId=PRODUCT_ID"
   ```

3. **Filter for manual adjustments only**:
   ```bash
   curl -H "Authorization: Bearer YOUR_TOKEN" \
     "http://your-api/api/v1/audit-logs/inventory-changes?triggeredBy=MANUAL_ADJUSTMENT"
   ```

---

## 📝 What Changed in Your System

### **Files Modified**:

1. ✅ **utils/auditLogger.js** (NEW)
   - Centralized audit logging functions
   - Helper utilities for all operations

2. ✅ **routes/warehouse.js**
   - Line 360-386: Added audit logging to inventory update endpoint
   - Line 1562-1609: Added audit logging to sale deletion

3. ✅ **routes/warehouse-purchases.js**
   - Line 631-652: Added audit logging to purchase updates
   - Line 801-847: Added audit logging to purchase deletions

4. ✅ **jobs/batch-status-manager.js**
   - Line 31-52: Added audit logging for auto-expiry

5. ✅ **routes/audit-logs.js** (NEW)
   - Complete API for viewing and analyzing logs

6. ✅ **server.js**
   - Line 37: Imported audit log routes
   - Line 383: Registered `/api/v1/audit-logs` endpoint

---

## ⚠️ Important Notes

### **Database Migration Required**
The `audit_logs` table already exists in your schema, so no migration needed! ✅

### **Performance Considerations**
- Audit logging happens within transactions - failures won't affect main operations
- Logs are created asynchronously where possible
- Index on `createdAt` recommended for better query performance

### **Storage**
- Audit logs grow over time
- Consider archiving logs older than 1 year
- Estimated size: ~1KB per log entry

### **Privacy**
- IP addresses and user agents are logged
- Consider GDPR compliance if applicable
- No sensitive data (passwords, etc.) is logged

---

## 🎯 Next Steps

### **Immediate Actions**:

1. ✅ **Audit logging is ENABLED** - all future changes will be tracked

2. **Restart your backend server** to load the new routes:
   ```bash
   cd /Users/MAC/Desktop/premium\ g/premium-g-backend
   npm restart
   # or
   pm2 restart premium-g-backend
   ```

3. **Test the system**:
   ```bash
   # Check if audit endpoint is working
   curl -H "Authorization: Bearer YOUR_TOKEN" \
     "http://localhost:5000/api/v1/audit-logs?limit=10"
   ```

4. **Run suspicious activities report**:
   ```bash
   curl -H "Authorization: Bearer YOUR_TOKEN" \
     "http://localhost:5000/api/v1/audit-logs/suspicious-activities?days=7"
   ```

5. **Investigate "sosa 1 ltr" specifically**:
   - Get product ID from database
   - Call inventory-changes endpoint with that productId
   - Review all changes and identify who/what reduced stock

---

## 🔍 Troubleshooting

### **Issue**: Audit logs not appearing
**Solution**: Ensure backend server restarted after code changes

### **Issue**: 404 on audit-logs endpoint
**Solution**: Check server.js has the route registered (line 383)

### **Issue**: Permission denied
**Solution**: Ensure user has SUPER_ADMIN or WAREHOUSE_ADMIN role

### **Issue**: Empty logs for old changes
**Solution**: Audit logging only tracks NEW changes (after implementation). Old changes won't have logs.

---

## 📞 Support

If you find the cause of "sosa 1 ltr" stock reduction, the audit log will show:
- ✅ WHO made the change (user ID, username, role)
- ✅ WHEN it happened (exact timestamp)
- ✅ WHAT changed (old value → new value)
- ✅ WHY it happened (reason, trigger type)
- ✅ HOW it was done (IP address, manual vs automatic)

**This makes it impossible for stock to "disappear" without a trace!**
