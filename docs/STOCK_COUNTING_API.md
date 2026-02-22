# Stock Counting API Documentation

## Overview

The Stock Counting feature allows warehouse staff to perform physical stock counts and compare them with system inventory. All counts require approval from authorized personnel (Warehouse Admin, Super Admin, or Cashier).

## Features

- ✅ Manual stock count entry by warehouse staff
- ✅ Automatic variance calculation (counted vs system stock)
- ✅ Approval workflow (only Warehouse Admin, Super Admin, Cashier can approve)
- ✅ Automatic inventory adjustment upon approval
- ✅ Stock adjustment audit trail
- ✅ Variance value calculation
- ✅ Create and update restrictions (only pending counts can be updated)
- ✅ Comprehensive reporting and filtering

## Authorization

### Who Can Create Stock Counts?
- Any user with **warehouse write** permission:
  - `WAREHOUSE_ADMIN`
  - `WAREHOUSE_SALES_OFFICER`
  - `SUPER_ADMIN`

### Who Can Approve/Reject Stock Counts?
- Only these roles can approve or reject:
  - `SUPER_ADMIN`
  - `WAREHOUSE_ADMIN`
  - `CASHIER`

### Who Can Update Stock Counts?
- The creator of the stock count (if status is PENDING)
- Warehouse Admin, Super Admin, or Cashier (if status is PENDING)

### Who Can Delete Stock Counts?
- Only `SUPER_ADMIN` and `WAREHOUSE_ADMIN`
- Can only delete PENDING or REJECTED counts

---

## API Endpoints

### Base URL
```
/api/v1/warehouse/stock-counts
```

---

## 1. Create Stock Count

**Endpoint:** `POST /api/v1/warehouse/stock-counts`

**Authorization:** Warehouse module - write permission

**Description:** Creates a new stock count record. The system automatically fetches current inventory levels and calculates variance.

### Request Body

```json
{
  "productId": "clxxx123456789",
  "location": "Main Warehouse",
  "countedPallets": 10,
  "countedPacks": 25,
  "countedUnits": 50,
  "countDate": "2024-01-29T10:00:00Z",
  "notes": "Monthly stock count"
}
```

### Request Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| productId | string (CUID) | Yes | Product to count |
| location | string | No | Storage location |
| countedPallets | integer | Yes | Physically counted pallets (≥0) |
| countedPacks | integer | Yes | Physically counted packs (≥0) |
| countedUnits | integer | Yes | Physically counted units (≥0) |
| countDate | ISO8601 | Yes | Date of physical count |
| notes | string | No | Additional notes |

### Response

```json
{
  "success": true,
  "message": "Stock count created successfully and submitted for approval",
  "data": {
    "id": "clxxx123456789",
    "countNumber": "SC-20240129-0001",
    "productId": "clxxx123456789",
    "location": "Main Warehouse",
    "countedPallets": 10,
    "countedPacks": 25,
    "countedUnits": 50,
    "systemPallets": 12,
    "systemPacks": 20,
    "systemUnits": 45,
    "variancePallets": -2,
    "variancePacks": 5,
    "varianceUnits": 5,
    "varianceValue": -450.50,
    "status": "PENDING",
    "countedBy": "clxxx123456789",
    "countDate": "2024-01-29T10:00:00.000Z",
    "notes": "Monthly stock count",
    "createdAt": "2024-01-29T10:30:00.000Z",
    "product": {
      "id": "clxxx123456789",
      "name": "Product A",
      "productNo": "PROD-001"
    },
    "countedByUser": {
      "id": "clxxx123456789",
      "username": "john.doe",
      "role": "WAREHOUSE_SALES_OFFICER"
    }
  }
}
```

**Status Codes:**
- `201` - Stock count created successfully
- `400` - Invalid input data
- `403` - Insufficient permissions
- `404` - Product not found

---

## 2. Get All Stock Counts

**Endpoint:** `GET /api/v1/warehouse/stock-counts`

**Authorization:** Warehouse module - read permission

**Description:** Retrieve all stock counts with optional filtering and pagination.

### Query Parameters

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| page | integer | Page number (default: 1) | `?page=2` |
| limit | integer | Items per page (default: 20, max: 100) | `?limit=50` |
| status | string | Filter by status | `?status=PENDING` |
| productId | string | Filter by product | `?productId=clxxx123` |
| location | string | Filter by location | `?location=Main%20Warehouse` |
| startDate | ISO8601 | Filter from date | `?startDate=2024-01-01` |
| endDate | ISO8601 | Filter to date | `?endDate=2024-01-31` |

### Status Values
- `PENDING` - Awaiting approval
- `APPROVED` - Approved (no variance or no adjustment made)
- `REJECTED` - Rejected by admin
- `ADJUSTED` - Approved and inventory adjusted

### Response

```json
{
  "success": true,
  "data": [
    {
      "id": "clxxx123456789",
      "countNumber": "SC-20240129-0001",
      "productId": "clxxx123456789",
      "location": "Main Warehouse",
      "countedPallets": 10,
      "countedPacks": 25,
      "countedUnits": 50,
      "systemPallets": 12,
      "systemPacks": 20,
      "systemUnits": 45,
      "variancePallets": -2,
      "variancePacks": 5,
      "varianceUnits": 5,
      "varianceValue": -450.50,
      "status": "PENDING",
      "countedBy": "clxxx123456789",
      "approvedBy": null,
      "approvedAt": null,
      "countDate": "2024-01-29T10:00:00.000Z",
      "notes": "Monthly stock count",
      "createdAt": "2024-01-29T10:30:00.000Z",
      "product": {
        "id": "clxxx123456789",
        "name": "Product A",
        "productNo": "PROD-001"
      },
      "countedByUser": {
        "id": "clxxx123456789",
        "username": "john.doe",
        "role": "WAREHOUSE_SALES_OFFICER"
      },
      "approver": null
    }
  ],
  "pagination": {
    "total": 150,
    "page": 1,
    "limit": 20,
    "pages": 8
  }
}
```

---

## 3. Get Single Stock Count

**Endpoint:** `GET /api/v1/warehouse/stock-counts/:id`

**Authorization:** Warehouse module - read permission

**Description:** Retrieve detailed information about a specific stock count, including adjustment history.

### Response

```json
{
  "success": true,
  "data": {
    "id": "clxxx123456789",
    "countNumber": "SC-20240129-0001",
    "productId": "clxxx123456789",
    "location": "Main Warehouse",
    "countedPallets": 10,
    "countedPacks": 25,
    "countedUnits": 50,
    "systemPallets": 12,
    "systemPacks": 20,
    "systemUnits": 45,
    "variancePallets": -2,
    "variancePacks": 5,
    "varianceUnits": 5,
    "varianceValue": -450.50,
    "status": "ADJUSTED",
    "approvalNotes": "Variance confirmed",
    "rejectionReason": null,
    "adjustmentReason": "Physical count verification",
    "countedBy": "clxxx123456789",
    "approvedBy": "clyyy987654321",
    "approvedAt": "2024-01-29T11:00:00.000Z",
    "countDate": "2024-01-29T10:00:00.000Z",
    "notes": "Monthly stock count",
    "createdAt": "2024-01-29T10:30:00.000Z",
    "updatedAt": "2024-01-29T11:00:00.000Z",
    "product": {
      "id": "clxxx123456789",
      "name": "Product A",
      "productNo": "PROD-001",
      "costPerPack": 100.00,
      "packsPerPallet": 20
    },
    "countedByUser": {
      "id": "clxxx123456789",
      "username": "john.doe",
      "role": "WAREHOUSE_SALES_OFFICER"
    },
    "approver": {
      "id": "clyyy987654321",
      "username": "admin",
      "role": "WAREHOUSE_ADMIN"
    },
    "adjustments": [
      {
        "id": "clzzz111222333",
        "stockCountId": "clxxx123456789",
        "productId": "clxxx123456789",
        "adjustmentPallets": -2,
        "adjustmentPacks": 5,
        "adjustmentUnits": 5,
        "beforePallets": 12,
        "beforePacks": 20,
        "beforeUnits": 45,
        "afterPallets": 10,
        "afterPacks": 25,
        "afterUnits": 50,
        "adjustmentValue": -450.50,
        "adjustmentReason": "Physical count verification",
        "adjustedBy": "clyyy987654321",
        "createdAt": "2024-01-29T11:00:00.000Z",
        "adjustedByUser": {
          "id": "clyyy987654321",
          "username": "admin",
          "role": "WAREHOUSE_ADMIN"
        }
      }
    ]
  }
}
```

---

## 4. Update Stock Count

**Endpoint:** `PUT /api/v1/warehouse/stock-counts/:id`

**Authorization:** Warehouse module - write permission (own entry or admin)

**Description:** Update a pending stock count. Only counts with PENDING status can be updated.

### Request Body

```json
{
  "countedPallets": 11,
  "countedPacks": 24,
  "countedUnits": 48,
  "notes": "Recounted - updated values"
}
```

### Request Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| countedPallets | integer | No | Updated pallet count (≥0) |
| countedPacks | integer | No | Updated pack count (≥0) |
| countedUnits | integer | No | Updated unit count (≥0) |
| notes | string | No | Updated notes |

**Note:** Variance is automatically recalculated when counted values are updated.

### Response

```json
{
  "success": true,
  "message": "Stock count updated successfully",
  "data": {
    "id": "clxxx123456789",
    "countNumber": "SC-20240129-0001",
    "countedPallets": 11,
    "countedPacks": 24,
    "countedUnits": 48,
    "variancePallets": -1,
    "variancePacks": 4,
    "varianceUnits": 3,
    "varianceValue": -380.00,
    "notes": "Recounted - updated values",
    "updatedAt": "2024-01-29T10:45:00.000Z"
  }
}
```

**Status Codes:**
- `200` - Updated successfully
- `400` - Invalid input or count not in PENDING status
- `403` - Not authorized to update this count
- `404` - Stock count not found

---

## 5. Approve Stock Count

**Endpoint:** `PUT /api/v1/warehouse/stock-counts/:id/approve`

**Authorization:** SUPER_ADMIN, WAREHOUSE_ADMIN, or CASHIER only

**Description:** Approve a stock count and automatically adjust inventory if there's a variance.

### Request Body

```json
{
  "approvalNotes": "Variance verified and approved",
  "adjustmentReason": "Physical count adjustment - monthly verification"
}
```

### Request Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| approvalNotes | string | No | Notes about the approval |
| adjustmentReason | string | No | Reason for inventory adjustment |

### What Happens on Approval?

1. **Stock count status** is updated to `APPROVED` or `ADJUSTED`
2. **If variance exists:**
   - Warehouse inventory is updated to match counted values
   - Stock adjustment record is created for audit trail
   - Status is set to `ADJUSTED`
3. **If no variance:**
   - Status is set to `APPROVED`
   - No inventory changes made

### Response

```json
{
  "success": true,
  "message": "Stock count approved and inventory adjusted successfully",
  "data": {
    "stockCount": {
      "id": "clxxx123456789",
      "countNumber": "SC-20240129-0001",
      "status": "ADJUSTED",
      "approvedBy": "clyyy987654321",
      "approvedAt": "2024-01-29T11:00:00.000Z",
      "approvalNotes": "Variance verified and approved",
      "adjustmentReason": "Physical count adjustment - monthly verification"
    },
    "adjustment": {
      "id": "clzzz111222333",
      "adjustmentPallets": -2,
      "adjustmentPacks": 5,
      "adjustmentUnits": 5,
      "adjustmentValue": -450.50,
      "beforePallets": 12,
      "beforePacks": 20,
      "beforeUnits": 45,
      "afterPallets": 10,
      "afterPacks": 25,
      "afterUnits": 50
    },
    "inventoryAdjusted": true
  }
}
```

**Status Codes:**
- `200` - Approved successfully
- `400` - Count not in PENDING status
- `403` - Insufficient permissions
- `404` - Stock count not found

---

## 6. Reject Stock Count

**Endpoint:** `PUT /api/v1/warehouse/stock-counts/:id/reject`

**Authorization:** SUPER_ADMIN, WAREHOUSE_ADMIN, or CASHIER only

**Description:** Reject a stock count. No inventory changes are made.

### Request Body

```json
{
  "rejectionReason": "Count appears inaccurate. Please recount product."
}
```

### Request Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| rejectionReason | string | **Yes** | Reason for rejection |

### Response

```json
{
  "success": true,
  "message": "Stock count rejected",
  "data": {
    "id": "clxxx123456789",
    "countNumber": "SC-20240129-0001",
    "status": "REJECTED",
    "approvedBy": "clyyy987654321",
    "approvedAt": "2024-01-29T11:00:00.000Z",
    "rejectionReason": "Count appears inaccurate. Please recount product."
  }
}
```

---

## 7. Delete Stock Count

**Endpoint:** `DELETE /api/v1/warehouse/stock-counts/:id`

**Authorization:** SUPER_ADMIN or WAREHOUSE_ADMIN only

**Description:** Delete a stock count. Only PENDING or REJECTED counts can be deleted.

### Response

```json
{
  "success": true,
  "message": "Stock count deleted successfully"
}
```

**Status Codes:**
- `200` - Deleted successfully
- `400` - Cannot delete (not PENDING or REJECTED)
- `403` - Insufficient permissions
- `404` - Stock count not found

---

## 8. Get Stock Count Summary

**Endpoint:** `GET /api/v1/warehouse/stock-counts/summary`

**Authorization:** Warehouse module - read permission

**Description:** Get summary statistics for stock counts.

### Response

```json
{
  "success": true,
  "data": {
    "totalCounts": 150,
    "pendingCounts": 25,
    "approvedCounts": 80,
    "rejectedCounts": 15,
    "adjustedCounts": 30,
    "totalVarianceValue": -15250.75
  }
}
```

---

## Database Schema

### StockCount Model

```prisma
model StockCount {
  id          String          @id @default(cuid())
  countNumber String          @unique @map("count_number")
  productId   String          @map("product_id")
  location    String?

  // Physical count
  countedPallets Int @map("counted_pallets")
  countedPacks   Int @map("counted_packs")
  countedUnits   Int @map("counted_units")

  // System stock at time of count
  systemPallets Int @map("system_pallets")
  systemPacks   Int @map("system_packs")
  systemUnits   Int @map("system_units")

  // Variance
  variancePallets Int @map("variance_pallets")
  variancePacks   Int @map("variance_packs")
  varianceUnits   Int @map("variance_units")
  varianceValue   Decimal? @map("variance_value")

  // Approval workflow
  status           StockCountStatus @default(PENDING)
  approvalNotes    String?
  rejectionReason  String?
  adjustmentReason String?

  // Tracking
  countedBy  String
  approvedBy String?
  approvedAt DateTime?
  countDate  DateTime
  notes      String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Relations
  product       Product
  countedByUser User
  approver      User?
  adjustments   StockAdjustment[]
}
```

### StockAdjustment Model

```prisma
model StockAdjustment {
  id           String @id @default(cuid())
  stockCountId String
  productId    String

  // Adjustment quantities
  adjustmentPallets Int
  adjustmentPacks   Int
  adjustmentUnits   Int

  // Before and after
  beforePallets Int
  beforePacks   Int
  beforeUnits   Int
  afterPallets  Int
  afterPacks    Int
  afterUnits    Int

  adjustmentValue  Decimal
  adjustmentReason String
  adjustedBy       String
  createdAt        DateTime @default(now())

  // Relations
  stockCount     StockCount
  product        Product
  adjustedByUser User
}
```

---

## Workflow Example

### Scenario: Monthly Stock Count

1. **Staff performs physical count**
   ```bash
   POST /api/v1/warehouse/stock-counts
   {
     "productId": "clxxx123",
     "countedPallets": 10,
     "countedPacks": 25,
     "countedUnits": 50,
     "countDate": "2024-01-29T10:00:00Z",
     "notes": "Monthly count"
   }
   ```

2. **System automatically:**
   - Fetches current inventory (12 pallets, 20 packs, 45 units)
   - Calculates variance (-2 pallets, +5 packs, +5 units)
   - Calculates variance value based on product cost
   - Sets status to PENDING

3. **Admin reviews count**
   ```bash
   GET /api/v1/warehouse/stock-counts?status=PENDING
   ```

4. **Admin approves (if variance is acceptable)**
   ```bash
   PUT /api/v1/warehouse/stock-counts/{id}/approve
   {
     "approvalNotes": "Variance verified",
     "adjustmentReason": "Monthly stock verification"
   }
   ```

5. **System automatically:**
   - Updates warehouse inventory to counted values
   - Creates stock adjustment record
   - Sets status to ADJUSTED

6. **Or Admin rejects (if variance is questionable)**
   ```bash
   PUT /api/v1/warehouse/stock-counts/{id}/reject
   {
     "rejectionReason": "Please recount - variance too large"
   }
   ```

---

## Error Handling

### Common Error Responses

**400 Bad Request**
```json
{
  "success": false,
  "error": "Invalid input data",
  "details": [
    {
      "field": "countedPallets",
      "message": "Counted pallets must be a non-negative integer"
    }
  ]
}
```

**403 Forbidden**
```json
{
  "success": false,
  "error": "Insufficient permissions",
  "message": "Only SUPER_ADMIN, WAREHOUSE_ADMIN, and CASHIER can approve stock counts"
}
```

**404 Not Found**
```json
{
  "success": false,
  "error": "Stock count not found"
}
```

**500 Internal Server Error**
```json
{
  "success": false,
  "error": "Internal server error",
  "message": "An unexpected error occurred"
}
```

---

## Best Practices

1. **Regular Counts:** Perform stock counts regularly (e.g., monthly) for accuracy
2. **Documentation:** Always add notes explaining unusual variances
3. **Timely Approval:** Review and approve/reject counts promptly
4. **Variance Investigation:** Investigate large variances before approval
5. **Audit Trail:** Use the adjustment records to track inventory changes
6. **Location Specific:** If you have multiple locations, count each location separately

---

## Security Notes

- All endpoints require authentication
- Role-based access control is strictly enforced
- Audit logs track all count creations, approvals, and rejections
- Stock adjustments are immutable once created
- Only admins can delete counts (and only PENDING/REJECTED ones)

---

## Support

For issues or questions about the Stock Counting API, contact the development team.
