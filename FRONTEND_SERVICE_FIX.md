# Frontend Service Fix - Remove Undefined Values

## Issue
Your console shows:
```javascript
paymentData: {
  amount: 19500,
  notes: undefined,      // ❌ This causes issues
  paymentDate: "2025-11-24",
  paymentMethod: "CASH",
  referenceNumber: undefined  // ❌ This causes issues
}
```

The backend's `.trim()` validator fails when it receives `undefined` values.

---

## ✅ Solution: Update Service Method

**File: `warehouseService.ts`**

Replace your `recordReceiptPayment` method with this:

```typescript
/**
 * Record payment for entire receipt (all products)
 * ✅ FIXED: Removes undefined values to avoid validation errors
 */
async recordReceiptPayment(receiptNumber: string, data: RecordPaymentData): Promise<any> {
    // Build payload without undefined values
    const paymentData: any = {
        amount: parseFloat(data.amount.toString()),
        paymentMethod: data.paymentMethod,
        paymentDate: data.paymentDate
    };

    // Only add optional fields if they have values
    if (data.referenceNumber && data.referenceNumber.trim()) {
        paymentData.referenceNumber = data.referenceNumber.trim();
    }

    if (data.notes && data.notes.trim()) {
        paymentData.notes = data.notes.trim();
    }

    console.log('Sending receipt payment:', {
        receiptNumber,
        paymentData
    });

    return this.post(paymentData, `/debtors/receipt/${receiptNumber}/payment`);
}
```

---

## Alternative: Use Spread Operator

If you prefer a cleaner approach:

```typescript
async recordReceiptPayment(receiptNumber: string, data: RecordPaymentData): Promise<any> {
    const paymentData = {
        amount: parseFloat(data.amount.toString()),
        paymentMethod: data.paymentMethod,
        paymentDate: data.paymentDate,
        // Only include if not empty
        ...(data.referenceNumber?.trim() && { referenceNumber: data.referenceNumber.trim() }),
        ...(data.notes?.trim() && { notes: data.notes.trim() })
    };

    console.log('Sending receipt payment:', {
        receiptNumber,
        paymentData
    });

    return this.post(paymentData, `/debtors/receipt/${receiptNumber}/payment`);
}
```

---

## Expected Payload After Fix

Your payload should now look like this:

```javascript
paymentData: {
  amount: 19500,
  paymentDate: "2025-11-24",
  paymentMethod: "CASH"
  // referenceNumber and notes are omitted if empty
}
```

Or if you enter values:

```javascript
paymentData: {
  amount: 19500,
  paymentDate: "2025-11-24",
  paymentMethod: "CASH",
  referenceNumber: "CASH-001",  // ✅ Only included if provided
  notes: "Test payment"          // ✅ Only included if provided
}
```

---

## Why This Fixes It

The backend validation uses `.trim()`:
```javascript
body('referenceNumber').optional().trim()
body('notes').optional().trim()
```

When you send `undefined` in JSON, express-validator tries to call `.trim()` on `undefined`, which fails.

By **not including** these fields when they're empty, the validator treats them as truly optional.

---

## Quick Test

After updating the service method, try the payment again. You should see in the console:

```javascript
Sending receipt payment: {
  receiptNumber: "20251114-9023",
  paymentData: {
    amount: 19500,
    paymentMethod: "CASH",
    paymentDate: "2025-11-24"
    // No undefined values!
  }
}
```

And the payment should succeed! ✅

---

## For Other Payment Methods Too

Update these methods similarly:

```typescript
// For individual debtor payment
async recordDebtorPayment(debtorId: string, data: RecordPaymentData): Promise<any> {
    const paymentData: any = {
        amount: parseFloat(data.amount.toString()),
        paymentMethod: data.paymentMethod,
        paymentDate: data.paymentDate
    };

    if (data.referenceNumber?.trim()) {
        paymentData.referenceNumber = data.referenceNumber.trim();
    }

    if (data.notes?.trim()) {
        paymentData.notes = data.notes.trim();
    }

    return this.post(paymentData, `/debtors/${debtorId}/payments`);
}

// For customer-wide payment
async recordCustomerDebtPayment(customerId: string, data: RecordPaymentData): Promise<any> {
    const paymentData: any = {
        amount: parseFloat(data.amount.toString()),
        paymentMethod: data.paymentMethod,
        paymentDate: data.paymentDate
    };

    if (data.referenceNumber?.trim()) {
        paymentData.referenceNumber = data.referenceNumber.trim();
    }

    if (data.notes?.trim()) {
        paymentData.notes = data.notes.trim();
    }

    return this.post(paymentData, `/debtors/customer/${customerId}/payment`);
}
```

---

## Summary

**Problem:** Sending `undefined` values in JSON payload causes backend validation to fail.

**Solution:** Don't include optional fields in the payload if they're empty/undefined.

**Result:** Payment will work! 🎉
