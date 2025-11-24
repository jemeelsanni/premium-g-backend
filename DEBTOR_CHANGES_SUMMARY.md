# Warehouse Debtor System Update - Complete Summary

## Overview
Updated the warehouse debtor system to display **debtors per sale/receipt** instead of grouped by customer.

---

## Backend Changes ✅ (Already Committed)

### File: `routes/warehouse-debtors.js`

**Changed Route: `GET /api/v1/warehouse/debtors`** (lines 15-161)

**Before:**
- Debtors grouped by customer
- Each customer showed aggregated debt across all sales
- Response structure included `customerDebt`, `sales[]`, `allPayments[]`

**After:**
- Debtors shown per individual sale/receipt
- Each debtor record = one sale transaction
- Direct flat list, no customer grouping

**Response Structure:**
```json
{
  "success": true,
  "data": {
    "debtors": [
      {
        "id": "debtor_abc123",
        "saleId": "sale_xyz789",
        "receiptNumber": "WHS-2024-001",
        "customer": {
          "id": "customer_123",
          "name": "John Doe",
          "phone": "08012345678",
          "email": "john@example.com",
          "customerType": "RETAILER",
          "paymentReliabilityScore": 85.5
        },
        "sale": {
          "id": "sale_xyz789",
          "receiptNumber": "WHS-2024-001",
          "product": {
            "id": "prod_456",
            "name": "Premium Rice 50kg",
            "productNo": "PR-001"
          },
          "quantity": 10,
          "unitType": "PACKS",
          "unitPrice": 25000.00,
          "totalAmount": 250000.00,
          "createdAt": "2024-11-20T10:30:00Z"
        },
        "totalAmount": 250000.00,
        "amountPaid": 100000.00,
        "amountDue": 150000.00,
        "status": "PARTIAL",
        "dueDate": "2024-12-20T00:00:00Z",
        "createdAt": "2024-11-20T10:30:00Z",
        "updatedAt": "2024-11-22T14:15:00Z",
        "payments": [
          {
            "id": "pay_111",
            "amount": 100000.00,
            "paymentMethod": "BANK_TRANSFER",
            "paymentDate": "2024-11-22T14:15:00Z",
            "referenceNumber": "TRF-12345",
            "notes": "First installment"
          }
        ],
        "paymentCount": 1,
        "lastPaymentDate": "2024-11-22T14:15:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 45,
      "pages": 3
    },
    "analytics": {
      "OUTSTANDING": {
        "count": 15,
        "totalAmount": 1500000,
        "amountPaid": 0,
        "amountDue": 1500000
      },
      "PARTIAL": {
        "count": 20,
        "totalAmount": 3000000,
        "amountPaid": 1200000,
        "amountDue": 1800000
      },
      "OVERDUE": {
        "count": 10,
        "totalAmount": 800000,
        "amountPaid": 200000,
        "amountDue": 600000
      }
    }
  }
}
```

### Payment Endpoints (Unchanged)

**1. Payment for Individual Sale**
```
POST /api/v1/warehouse/debtors/:debtorId/payments
```
- Records payment for a specific sale debt
- Updates debtor record
- Updates warehouse sale payment status
- Creates cash flow entry
- Updates customer statistics

**2. Payment for Customer (All Debts) - Still Available**
```
POST /api/v1/warehouse/debtors/customer/:customerId/payment
```
- Distributes payment across all customer debts (FIFO - oldest first)
- Can still be used if frontend wants to support paying all customer debts at once

---

## Frontend Changes Required 🔧

### 1. Update TypeScript Interface

**File: `src/types/warehouse.ts` or similar**

Replace the old `AggregatedDebtor` interface with:

```typescript
interface DebtorPerSale {
    id: string;
    saleId: string;
    receiptNumber: string;
    customer: {
        id: string;
        name: string;
        phone: string;
        email: string | null;
        customerType: string;
        paymentReliabilityScore: number;
    };
    sale: {
        id: string;
        receiptNumber: string;
        product: {
            id: string;
            name: string;
            productNo: string;
        };
        quantity: number;
        unitType: string;
        unitPrice: number;
        totalAmount: number;
        createdAt: string;
    };
    totalAmount: number;
    amountPaid: number;
    amountDue: number;
    status: 'OUTSTANDING' | 'PARTIAL' | 'OVERDUE' | 'PAID';
    dueDate: string | null;
    createdAt: string;
    updatedAt: string;
    payments: Array<{
        id: string;
        amount: number;
        paymentMethod: string;
        paymentDate: string;
        referenceNumber?: string;
        notes?: string;
    }>;
    paymentCount: number;
    lastPaymentDate: string | null;
}
```

### 2. Update Service Method

**File: `src/services/warehouseService.ts`**

No changes needed to `getDebtors()` - it already works.

For payments, the `recordDebtorPayment()` method already targets individual debtors:

```typescript
async recordDebtorPayment(debtorId: string, data: RecordPaymentData): Promise<any> {
    return this.post(data, `/debtors/${debtorId}/payments`);
}
```

### 3. Update Component

**File: `src/components/warehouse/DebtorsDashboard.tsx`**

See `DEBTOR_DASHBOARD_UPDATED.tsx` for the complete updated component.

**Key Changes:**
- Removed customer grouping logic
- Each debtor row displays one sale/receipt
- Simplified payment flow (payment per sale)
- Added receipt number links
- Expandable payment history per sale
- Cleaner UI focused on individual transactions

---

## Migration Steps

### For Frontend Developers:

1. **Update TypeScript Interfaces**
   - Replace `AggregatedDebtor` with `DebtorPerSale`
   - Update any related types

2. **Replace Component File**
   - Copy contents from `DEBTOR_DASHBOARD_UPDATED.tsx`
   - Update import paths if needed
   - Test the UI

3. **Test Payment Flow**
   - Verify payments work for individual sales
   - Check that cash flow is recorded
   - Verify sale status updates

4. **Optional: Keep Customer-Wide Payments**
   - If you want users to pay all debts at once
   - Keep the `recordCustomerDebtPayment()` method
   - Add UI for "Pay All Debts" button

---

## Key Benefits

### 1. **Clearer Debt Tracking**
- Each sale is tracked independently
- Easy to see which specific sales have outstanding balances
- Direct link between receipt and debt

### 2. **Better Alignment with Sales**
- Matches the `/sales/receipt/:receiptNumber` endpoint structure
- Consistent data model across warehouse module

### 3. **Simplified Payment Flow**
- Users pay for specific sales/receipts
- No confusion about which sales are being paid
- Clear payment history per transaction

### 4. **Improved User Experience**
- Receipt-based navigation
- Product details visible in debtor list
- Payment history per sale
- Better search and filter capabilities

---

## Testing Checklist

- [ ] Debtor list displays correctly
- [ ] Pagination works
- [ ] Status filtering works
- [ ] Payment modal opens with correct data
- [ ] Payment submission works
- [ ] Payment amount validation works
- [ ] Cash flow entry is created
- [ ] Sale payment status updates
- [ ] Customer statistics update
- [ ] Receipt links work
- [ ] Payment history displays correctly
- [ ] Analytics cards show correct data

---

## API Endpoints Summary

### Debtors
```
GET    /api/v1/warehouse/debtors                                  # List all debtors (per sale)
GET    /api/v1/warehouse/debtors/customer/:customerId/summary     # Customer debt summary
GET    /api/v1/warehouse/debtors/analytics                        # Debt analytics
POST   /api/v1/warehouse/debtors/:debtorId/payments              # Pay specific sale debt
POST   /api/v1/warehouse/debtors/customer/:customerId/payment    # Pay all customer debts
```

### Related Endpoints
```
GET    /api/v1/warehouse/sales/receipt/:receiptNumber            # View sale receipt
GET    /api/v1/warehouse/customers/:customerId                   # Customer details
GET    /api/v1/warehouse/customers/:customerId/purchases         # Customer purchase history
```

---

## Example Usage

### Fetch Debtors
```typescript
const response = await warehouseService.getDebtors({
    page: 1,
    limit: 20,
    status: 'PARTIAL'  // or 'all', 'OUTSTANDING', 'OVERDUE', 'PAID'
});

// response.data.debtors is now DebtorPerSale[]
```

### Record Payment for a Sale
```typescript
const paymentData = {
    amount: 50000,
    paymentMethod: 'CASH',
    paymentDate: '2024-11-24',
    referenceNumber: 'CASH-001',
    notes: 'Partial payment'
};

await warehouseService.recordDebtorPayment(debtorId, paymentData);
```

---

## Notes

- **Backward Compatibility**: The customer-wide payment endpoint still exists if needed
- **No Database Changes**: Only route logic changed, Prisma schema unchanged
- **Cash Flow Integration**: Still working - every payment creates cash flow entry
- **Customer Stats**: Still updated correctly on each payment

---

## Files to Copy to Frontend

1. **DEBTOR_DASHBOARD_UPDATED.tsx** → Replace your current `DebtorsDashboard.tsx`
2. **FRONTEND_UPDATES.md** → Reference for interface changes

---

## Questions?

If you encounter issues:
1. Check the backend is running the latest code (commit: df6afaf)
2. Verify API responses match the new structure
3. Check browser console for errors
4. Test with Postman/curl first to isolate frontend issues

---

## Commit Reference

Backend changes committed as:
```
commit df6afaf
feat: update warehouse debtors to show per sale/receipt
```
