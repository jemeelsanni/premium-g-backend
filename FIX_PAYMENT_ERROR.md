# Fix for 400 Error - Receipt Payment

## Issue
Getting 400 Bad Request when recording payment for receipt.

## Root Cause
The `recordReceiptPayment` method might not be properly implemented or the data format is incorrect.

---

## Solution

### 1. Update `warehouseService.ts`

Add this method to your `WarehouseService` class:

```typescript
/**
 * Record payment for entire receipt (all products)
 */
async recordReceiptPayment(receiptNumber: string, data: RecordPaymentData): Promise<any> {
    // IMPORTANT: Validate data before sending
    const paymentData = {
        amount: parseFloat(data.amount.toString()), // Ensure it's a number
        paymentMethod: data.paymentMethod,
        paymentDate: data.paymentDate, // Must be ISO8601 format (YYYY-MM-DD or full ISO string)
        referenceNumber: data.referenceNumber || undefined,
        notes: data.notes || undefined
    };

    console.log('Sending receipt payment:', {
        receiptNumber,
        paymentData
    });

    return this.post(paymentData, `/debtors/receipt/${receiptNumber}/payment`);
}
```

---

### 2. Check `RecordPaymentData` Interface

Make sure your interface matches:

```typescript
export interface RecordPaymentData {
  amount: number;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD' | 'MOBILE_MONEY';
  paymentDate: string; // ISO8601 format: "2024-11-24" or "2024-11-24T00:00:00Z"
  referenceNumber?: string;
  notes?: string;
}
```

---

### 3. Update Component Payment Handler

In your `DebtorsDashboard` component, ensure the payment data is formatted correctly:

```typescript
const handleRecordPayment = async () => {
    if (!selectedReceipt) return;

    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) {
        alert('Please enter a valid payment amount');
        return;
    }

    if (amount > selectedReceipt.amountDue) {
        alert(`Payment amount cannot exceed outstanding balance of ${formatCurrency(selectedReceipt.amountDue)}`);
        return;
    }

    try {
        setProcessingPayment(true);

        // ✅ Ensure correct data format
        const paymentData: RecordPaymentData = {
            amount: amount, // Already parsed as float
            paymentMethod: paymentMethod, // Should be one of the enum values
            paymentDate: paymentDate, // Should be YYYY-MM-DD format from input[type="date"]
            referenceNumber: paymentReference.trim() || undefined,
            notes: paymentNotes.trim() || undefined
        };

        console.log('Submitting payment:', {
            receiptNumber: selectedReceipt.receiptNumber,
            paymentData
        });

        const response = await warehouseService.recordReceiptPayment(
            selectedReceipt.receiptNumber,
            paymentData
        );

        console.log('Payment response:', response);

        alert(
            `✅ Payment recorded successfully!\n\n` +
            `Receipt: ${selectedReceipt.receiptNumber}\n` +
            `Amount: ${formatCurrency(amount)}\n` +
            `Products Updated: ${response.data.debtsUpdated}`
        );

        closePaymentModal();
        fetchDebtors();
    } catch (error: any) {
        console.error('Failed to record payment:', error);

        // ✅ Show detailed error message
        const errorMessage = error?.response?.data?.details
            ? JSON.stringify(error.response.data.details, null, 2)
            : error?.response?.data?.message || 'Failed to record payment';

        alert(`Error: ${errorMessage}`);
    } finally {
        setProcessingPayment(false);
    }
};
```

---

## Common Issues and Fixes

### Issue 1: `paymentMethod` validation fails
**Problem:** Frontend sends wrong case or value
**Fix:** Ensure paymentMethod is one of: `'CASH'`, `'BANK_TRANSFER'`, `'CHECK'`, `'CARD'`, `'MOBILE_MONEY'`

```typescript
// Check your select dropdown values match exactly
<select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as any)}>
    <option value="CASH">Cash</option>
    <option value="BANK_TRANSFER">Bank Transfer</option>
    <option value="CHECK">Check</option>
    <option value="CARD">Card</option>
    <option value="MOBILE_MONEY">Mobile Money</option>
</select>
```

### Issue 2: `paymentDate` format
**Problem:** Date not in ISO8601 format
**Fix:** Use `input[type="date"]` which automatically returns YYYY-MM-DD format

```typescript
// This is correct:
<input
    type="date"
    value={paymentDate}
    onChange={(e) => setPaymentDate(e.target.value)}
/>

// Initialize with:
const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
```

### Issue 3: `amount` not a valid float
**Problem:** Amount sent as string or with commas
**Fix:** Parse to float before sending

```typescript
const amount = parseFloat(paymentAmount); // Remove commas and parse
if (isNaN(amount)) {
    alert('Invalid amount');
    return;
}
```

---

## Testing Steps

1. **Check Browser Console:**
   - Open DevTools → Console
   - Look for "Submitting payment:" log
   - Verify the data format

2. **Check Network Tab:**
   - Open DevTools → Network
   - Find the POST request to `/receipt/{receiptNumber}/payment`
   - Check the Request Payload

3. **Expected Payload:**
```json
{
  "amount": 50000,
  "paymentMethod": "CASH",
  "paymentDate": "2024-11-24",
  "referenceNumber": "REF-123",
  "notes": "Test payment"
}
```

4. **Check Backend Logs:**
   - With the updated code, you'll now see detailed validation errors
   - Look for "❌ Receipt payment validation failed:" in logs
   - It will show exactly which field failed validation

---

## Quick Test

Try this minimal test in browser console:

```javascript
// Test the service method directly
const testPayment = async () => {
    const data = {
        amount: 1000,
        paymentMethod: 'CASH',
        paymentDate: '2024-11-24',
        referenceNumber: 'TEST-001',
        notes: 'Test payment'
    };

    try {
        const response = await fetch('https://premium-g-backend-production.up.railway.app/api/v1/warehouse/debtors/receipt/20251114-9023/payment', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer YOUR_TOKEN_HERE' // Replace with actual token
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();
        console.log('Response:', result);
    } catch (error) {
        console.error('Error:', error);
    }
};

testPayment();
```

---

## Backend Changes Made

I've updated the backend to provide better error messages. The validation errors will now include:
- Which field failed
- What the validation rule was
- What value was received

This will help identify the exact issue.

---

## Next Steps

1. **Deploy Updated Backend** - The improved error logging is now in the code
2. **Check Logs** - After deploying, try the payment again and check Railway logs
3. **You'll See** - Exact field that's failing validation with details
4. **Fix Frontend** - Update the data format based on the validation error details

The error should now show something like:
```json
{
  "success": false,
  "error": "Validation Error",
  "message": "Invalid payment data",
  "details": [
    {
      "field": "paymentMethod",
      "message": "Invalid value",
      "value": "cash"
    }
  ]
}
```
