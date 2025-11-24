# Warehouse Debtor System - Receipt Grouping Update

## ✅ Final Implementation

The warehouse debtor system now correctly **groups by receipt number** to avoid duplication when a receipt has multiple products.

---

## How It Works Now

### Before (Issue):
```
Receipt: WHS-2024-001
├── Product A (Debtor 1) - Shows as separate row
└── Product B (Debtor 2) - Shows as separate row ❌ DUPLICATE

Receipt count: 2 (but it's really 1 receipt!)
```

### After (Fixed):
```
Receipt: WHS-2024-001 (One debtor row)
├── Total: ₦150,000
├── Paid: ₦50,000
├── Due: ₦100,000
└── When expanded shows:
    ├── Product A: Rice 50kg
    └── Product B: Oil 25L
```

---

## API Response Structure

**GET `/api/v1/warehouse/debtors`** now returns:

```json
{
  "success": true,
  "data": {
    "debtors": [
      {
        "receiptNumber": "WHS-2024-001",
        "customer": {
          "id": "cust_123",
          "name": "John Doe",
          "phone": "08012345678",
          "email": "john@example.com",
          "customerType": "RETAILER",
          "paymentReliabilityScore": 85.5
        },
        "totalAmount": 150000.00,
        "amountPaid": 50000.00,
        "amountDue": 100000.00,
        "status": "PARTIAL",
        "dueDate": "2024-12-20T00:00:00Z",
        "createdAt": "2024-11-20T10:30:00Z",
        "paymentMethod": "CREDIT",
        "products": [
          {
            "debtorId": "debtor_abc1",
            "saleId": "sale_xyz1",
            "product": {
              "id": "prod_001",
              "name": "Premium Rice 50kg",
              "productNo": "PR-001"
            },
            "quantity": 10,
            "unitType": "PACKS",
            "unitPrice": 5000.00,
            "totalAmount": 50000.00,
            "amountPaid": 20000.00,
            "amountDue": 30000.00,
            "status": "PARTIAL"
          },
          {
            "debtorId": "debtor_abc2",
            "saleId": "sale_xyz2",
            "product": {
              "id": "prod_002",
              "name": "Vegetable Oil 25L",
              "productNo": "VO-002"
            },
            "quantity": 20,
            "unitType": "UNITS",
            "unitPrice": 5000.00,
            "totalAmount": 100000.00,
            "amountPaid": 30000.00,
            "amountDue": 70000.00,
            "status": "PARTIAL"
          }
        ],
        "debtorIds": ["debtor_abc1", "debtor_abc2"],
        "allPayments": [
          {
            "id": "pay_111",
            "amount": 50000.00,
            "paymentMethod": "CASH",
            "paymentDate": "2024-11-22T14:15:00Z",
            "referenceNumber": "CASH-001",
            "notes": "First payment"
          }
        ],
        "paymentCount": 1,
        "lastPaymentDate": "2024-11-22T14:15:00Z",
        "productCount": 2
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 15,
      "pages": 1
    },
    "analytics": {
      "OUTSTANDING": {
        "count": 5,
        "totalAmount": 500000,
        "amountPaid": 0,
        "amountDue": 500000
      },
      "PARTIAL": {
        "count": 8,
        "totalAmount": 1200000,
        "amountPaid": 400000,
        "amountDue": 800000
      },
      "OVERDUE": {
        "count": 2,
        "totalAmount": 300000,
        "amountPaid": 50000,
        "amountDue": 250000
      }
    }
  }
}
```

---

## New Payment Endpoint

### Pay Entire Receipt at Once

**Endpoint:** `POST /api/v1/warehouse/debtors/receipt/:receiptNumber/payment`

**Purpose:** Record payment for an entire receipt (all products together)

**Request Body:**
```json
{
  "amount": 50000,
  "paymentMethod": "CASH",
  "paymentDate": "2024-11-24",
  "referenceNumber": "CASH-12345",
  "notes": "Partial payment for receipt"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Payment of ₦50,000.00 recorded successfully for receipt WHS-2024-001",
  "data": {
    "receiptNumber": "WHS-2024-001",
    "totalPayment": 50000,
    "debtsUpdated": 2,
    "salesUpdated": 2,
    "paymentAllocation": [
      {
        "debtId": "debtor_abc1",
        "amountAllocated": 30000,
        "newStatus": "PAID"
      },
      {
        "debtId": "debtor_abc2",
        "amountAllocated": 20000,
        "newStatus": "PARTIAL"
      }
    ],
    "cashFlowRecorded": true,
    "cashFlowId": "cf_xyz789"
  }
}
```

**How Payment Distribution Works:**
1. Payment is distributed across all products in the receipt (FIFO - oldest first)
2. Each product's debtor record is updated
3. Each product's sale status is updated
4. Single cash flow entry created for the entire payment
5. Customer statistics updated

---

## Payment Endpoints Summary

### 1. Pay Individual Product Debt
```
POST /api/v1/warehouse/debtors/:debtorId/payments
```
- Use when paying for a specific product in a receipt
- Targets one debtor record

### 2. Pay Entire Receipt (NEW - RECOMMENDED)
```
POST /api/v1/warehouse/debtors/receipt/:receiptNumber/payment
```
- **Use this for receipt-based payments**
- Automatically distributes across all products in receipt
- Handles multi-product receipts correctly

### 3. Pay All Customer Debts
```
POST /api/v1/warehouse/debtors/customer/:customerId/payment
```
- Pay across all receipts for a customer
- Distributes FIFO across oldest receipts first

---

## Frontend TypeScript Interface

```typescript
interface DebtorReceipt {
    receiptNumber: string;
    customer: {
        id: string;
        name: string;
        phone: string;
        email: string | null;
        customerType: string;
        paymentReliabilityScore: number;
    };
    totalAmount: number;
    amountPaid: number;
    amountDue: number;
    status: 'OUTSTANDING' | 'PARTIAL' | 'OVERDUE' | 'PAID';
    dueDate: string | null;
    createdAt: string;
    paymentMethod: string;
    products: Array<{
        debtorId: string;
        saleId: string;
        product: {
            id: string;
            name: string;
            productNo: string;
        };
        quantity: number;
        unitType: string;
        unitPrice: number;
        totalAmount: number;
        amountPaid: number;
        amountDue: number;
        status: string;
    }>;
    debtorIds: string[];
    allPayments: Array<{
        id: string;
        amount: number;
        paymentMethod: string;
        paymentDate: string;
        referenceNumber?: string;
        notes?: string;
    }>;
    paymentCount: number;
    lastPaymentDate: string | null;
    productCount: number;
}
```

---

## Frontend Service Method

**Add to `warehouseService.ts`:**

```typescript
async recordReceiptPayment(receiptNumber: string, data: RecordPaymentData): Promise<any> {
    return this.post(data, `/debtors/receipt/${receiptNumber}/payment`);
}
```

---

## Frontend Component Updates

**Updated payment flow:**

```typescript
const handleRecordPayment = async () => {
    if (!selectedDebtor) return;

    const amount = parseFloat(paymentAmount);
    // ... validation ...

    try {
        setProcessingPayment(true);

        const paymentData = {
            amount: amount,
            paymentMethod,
            paymentDate,
            referenceNumber: paymentReference || undefined,
            notes: paymentNotes || undefined
        };

        // ✅ NEW: Payment for entire receipt
        const response = await warehouseService.recordReceiptPayment(
            selectedDebtor.receiptNumber,
            paymentData
        );

        console.log('Payment response:', response);

        alert(
            `✅ Payment recorded successfully!\n\n` +
            `Receipt: ${selectedDebtor.receiptNumber}\n` +
            `Amount: ${formatCurrency(amount)}\n` +
            `Products Updated: ${response.data.debtsUpdated}\n` +
            `New Balance: ${formatCurrency(selectedDebtor.amountDue - amount)}`
        );

        closePaymentModal();
        fetchDebtors();
    } catch (error: any) {
        console.error('Failed to record payment:', error);
        alert(error?.response?.data?.message || 'Failed to record payment');
    } finally {
        setProcessingPayment(false);
    }
};
```

---

## Key Benefits

1. **No Duplication**: Each receipt appears once, regardless of product count
2. **Clearer View**: Total receipt debt shown at a glance
3. **Product Details**: All products visible when expanded
4. **Unified Payment**: One payment covers all products in receipt
5. **Automatic Distribution**: Payment intelligently split across products
6. **Cash Flow Integrity**: Single cash entry per receipt payment

---

## Migration Notes

### From Previous Version:

**Before:** Individual products were separate debtor rows
**After:** Receipts grouped, products nested

**Action Required:**
1. Update frontend interface from `DebtorPerSale` to `DebtorReceipt`
2. Change payment method from `recordDebtorPayment()` to `recordReceiptPayment()`
3. Update UI to show products in expandable section
4. Test with multi-product receipts

---

## Testing Checklist

- [ ] Single-product receipt displays correctly
- [ ] Multi-product receipt displays as one row
- [ ] Product list expands when clicked
- [ ] Payment modal shows receipt details
- [ ] Payment for full amount clears entire receipt
- [ ] Partial payment distributes correctly across products
- [ ] Cash flow entry created correctly
- [ ] Sale status updates for all products
- [ ] Customer stats update correctly
- [ ] Analytics counts receipts, not products

---

## Example Usage

### Fetch Debtors (Grouped by Receipt)
```typescript
const response = await warehouseService.getDebtors({
    page: 1,
    limit: 20,
    status: 'PARTIAL'
});

// response.data.debtors is now DebtorReceipt[]
// Each item represents one receipt with multiple products
```

### Pay for a Receipt
```typescript
const paymentData = {
    amount: 75000,
    paymentMethod: 'BANK_TRANSFER',
    paymentDate: '2024-11-24',
    referenceNumber: 'TRF-12345',
    notes: 'Payment for WHS-2024-001'
};

await warehouseService.recordReceiptPayment('WHS-2024-001', paymentData);
```

---

## Commit Reference

```
commit 3356195
fix: group debtors by receipt number to avoid duplication
```

All changes have been pushed to `claude/fix-warehouse-debtors-01MLbAtMAQ8YtQyS3SRJgpLC`.
