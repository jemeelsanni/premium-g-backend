# Debt Calculation Fix - Backend AND Frontend Issues

## Problem Summary
Outstanding debt on sale details and debtor pages is calculating incorrectly after sales are created. The issue occurs when:
1. Multiple products are added to the cart
2. Some products have discounts applied (or not)
3. A partial payment is made on a credit sale

## Root Causes (TWO BUGS!)

### Bug #1: Backend - Not Aggregating Debtor Amounts ⚠️ CRITICAL
The backend endpoint `/api/v1/warehouse/sales/receipt/:receiptNumber` only captured debtor info from the **first sale** in a receipt, instead of summing amounts from ALL sales.

**Example:**
- Cart: Item A (₦24,000) + Item B (₦48,000) = ₦72,000 total
- Partial payment: ₦60,000
- Creates 2 sales: Sale A (paid ₦20,000) + Sale B (paid ₦40,000)
- **Bug:** Sale details page showed ₦20,000 paid instead of ₦60,000 (only showing Sale A's payment)

### Bug #2: Frontend - Wrong Payment Proportions (when discounts exist)
In `CreateSale.tsx`, the proportional payment allocation uses **original prices** instead of **discounted prices** when calculating how much of the partial payment should be allocated to each product.

### Bug Location
File: `src/pages/warehouse/CreateSale.tsx`
Line: Inside `createSaleMutation.mutationFn` function

```typescript
// ❌ CURRENT (INCORRECT) CODE
const salePromises = cart.map(item => {
    const itemTotal = item.quantity * item.unitPrice;  // BUG: Uses original price

    // Calculate proportional partial payment
    let itemAmountPaid = 0;
    if (totalAmountPaid > 0 && cartTotal > 0) {
        itemAmountPaid = (itemTotal / cartTotal) * totalAmountPaid;  // Wrong proportion
    }

    // ... rest of code
});
```

### Why This Is Wrong
- `item.unitPrice` = **original** unit price (before discount)
- `item.discountedUnitPrice` = **discounted** unit price (after discount)
- `item.finalTotal` = `quantity × discountedUnitPrice` (correct total)
- `cartTotal` = sum of all `finalTotal` values (correct)

When using `item.quantity * item.unitPrice`, you're multiplying by the **wrong price**, creating a mismatch with `cartTotal`.

## Example Scenario

### Cart Contents:
- **Product A**: 10 units @ ₦100 original → ₦80 discounted (20% off)
  - `finalTotal` = 10 × ₦80 = **₦800**
- **Product B**: 5 units @ ₦200 (no discount)
  - `finalTotal` = 5 × ₦200 = **₦1,000**
- **Cart Total**: ₦1,800

### Partial Payment: ₦900

#### Current (WRONG) Behavior:
```
Item A itemTotal = 10 × ₦100 = ₦1,000  ❌ (uses original price)
Item B itemTotal = 5 × ₦200 = ₦1,000   ✅
Wrong base = ₦2,000

Item A payment = (₦1,000 / ₦2,000) × ₦900 = ₦450  ❌
Item B payment = (₦1,000 / ₦2,000) × ₦900 = ₦450  ❌

BACKEND RECEIVES:
- Sale A: totalAmount=₦800, amountPaid=₦450 → amountDue=₦350 ❌
- Sale B: totalAmount=₦1000, amountPaid=₦450 → amountDue=₦550 ❌
```

#### Expected (CORRECT) Behavior:
```
Item A finalTotal = ₦800  ✅
Item B finalTotal = ₦1,000 ✅
Correct base = ₦1,800

Item A payment = (₦800 / ₦1,800) × ₦900 = ₦400  ✅
Item B payment = (₦1,000 / ₦1,800) × ₦900 = ₦500  ✅

BACKEND RECEIVES:
- Sale A: totalAmount=₦800, amountPaid=₦400 → amountDue=₦400 ✅
- Sale B: totalAmount=₦1000, amountPaid=₦500 → amountDue=₦500 ✅
```

## The Fixes

### Backend Fix (✅ ALREADY APPLIED)
**File:** `/routes/warehouse.js` (lines 1241-1265)

**What Changed:** Modified the receipt aggregation logic to sum debtor amounts from ALL sales in a receipt.

**Before:**
```javascript
// ❌ Only captured first debtor
if (sale.debtor && !aggregatedSale.debtor) {
    aggregatedSale.debtor = {
        id: sale.debtor.id,
        amountPaid: Number(sale.debtor.amountPaid),  // Only first sale!
        amountDue: Number(sale.debtor.amountDue),    // Only first sale!
        status: sale.debtor.status,
        dueDate: sale.debtor.dueDate
    };
}
```

**After:**
```javascript
// ✅ Aggregates ALL debtor amounts
if (sale.debtor) {
    if (!aggregatedSale.debtor) {
        aggregatedSale.debtor = {
            id: sale.debtor.id,
            amountPaid: 0,
            amountDue: 0,
            status: sale.debtor.status,
            dueDate: sale.debtor.dueDate
        };
    }

    // Sum amounts from all sales
    aggregatedSale.debtor.amountPaid += Number(sale.debtor.amountPaid);
    aggregatedSale.debtor.amountDue += Number(sale.debtor.amountDue);

    // Update status to worst case
    const statusPriority = { 'OVERDUE': 4, 'PARTIAL': 3, 'OUTSTANDING': 2, 'PAID': 1 };
    if (statusPriority[sale.debtor.status] > statusPriority[aggregatedSale.debtor.status]) {
        aggregatedSale.debtor.status = sale.debtor.status;
    }
}
```

**Impact:** This fixes the immediate issue where sale details page shows wrong amounts. Your scenario (₦60,000 paid, ₦12,000 due) should now display correctly!

### Frontend Fix (⚠️ STILL NEEDED for discount cases)
**File:** `src/pages/warehouse/CreateSale.tsx`

### Solution (Frontend)
Replace the incorrect `itemTotal` calculation with the pre-calculated `finalTotal`:

```typescript
// ✅ FIXED CODE
const salePromises = cart.map(item => {
    const itemTotal = item.finalTotal;  // FIX: Use pre-calculated final total

    // Calculate proportional partial payment
    let itemAmountPaid = 0;
    if (totalAmountPaid > 0 && cartTotal > 0) {
        itemAmountPaid = (itemTotal / cartTotal) * totalAmountPaid;  // Now correct
    }

    // ... rest of code
});
```

### Complete Fixed Function

```typescript
const createSaleMutation = useMutation({
    mutationFn: async (saleData: SaleFormData) => {
        const receiptNumber = await generateReceiptNumber();
        const cartTotal = cartTotals.total;

        // Clean the amount paid to prevent multiplication
        const totalAmountPaid = showPartialPayment && saleData.amountPaid
            ? parseFloat(String(saleData.amountPaid).replace(/[₦,\s]/g, ''))
            : 0;

        console.log('💰 FRONTEND PAYMENT CALC:', {
            showPartialPayment,
            rawAmountPaid: saleData.amountPaid,
            cleanedAmountPaid: totalAmountPaid,
            cartTotal
        });

        const salePromises = cart.map(item => {
            // ✅ FIX: Use finalTotal instead of recalculating
            const itemTotal = item.finalTotal;

            // Calculate proportional partial payment
            let itemAmountPaid = 0;
            if (totalAmountPaid > 0 && cartTotal > 0) {
                itemAmountPaid = (itemTotal / cartTotal) * totalAmountPaid;
            }

            const selectedCustomer = customersData?.data?.customers?.find(
                (c: any) => c.id === saleData.warehouseCustomerId
            );

            const payload: any = {
                productId: item.productId,
                quantity: item.quantity,
                unitType: item.unitType,
                unitPrice: item.discountedUnitPrice,  // Already correct
                warehouseCustomerId: saleData.warehouseCustomerId,
                customerName: selectedCustomer?.name || '',
                customerPhone: selectedCustomer?.phone || '',
                receiptNumber
            };

            // Handle credit sales properly
            if (saleData.paymentMethod === 'CREDIT') {
                payload.paymentStatus = 'CREDIT';
                payload.creditDueDate = saleData.creditDueDate;
                payload.creditNotes = saleData.creditNotes;

                if (showPartialPayment && itemAmountPaid > 0) {
                    payload.amountPaid = itemAmountPaid;
                    payload.initialPaymentMethod = saleData.initialPaymentMethod;
                    payload.paymentMethod = saleData.initialPaymentMethod;
                } else {
                    delete payload.paymentMethod;
                }
            } else {
                payload.paymentStatus = 'PAID';
                payload.paymentMethod = saleData.paymentMethod;
            }

            console.log('📤 Sending sale payload:', payload);
            return warehouseService.createSale(payload);
        });

        return Promise.all(salePromises);
    },
    // ... rest of mutation config
});
```

## Backend Verification

The backend code in `/routes/warehouse.js` is **correct** - it properly calculates:

```javascript
// Line 780 in warehouse.js
const amountDue = parseFloat((totalAmount - amountPaid).toFixed(2));

const debtor = await tx.debtor.create({
    data: {
        totalAmount,     // ✅ Correct from payload
        amountPaid,      // ✅ Should be correct IF frontend sends right value
        amountDue,       // ✅ Calculated correctly: totalAmount - amountPaid
        // ...
    }
});
```

The backend correctly creates debtor records based on what the frontend sends. The issue is that the frontend was sending incorrect `amountPaid` values due to the proportion calculation bug.

## Testing

After applying the fix, test with this scenario:

1. **Create a customer**
2. **Add 2-3 products to cart**, some with discounts
3. **Select "Credit" payment method**
4. **Enable partial payment** and enter an amount (e.g., 50% of total)
5. **Record the sale**
6. **Verify in Debtor Dashboard:**
   - Each product's `amountDue` should be proportional to its discounted price
   - Sum of all `amountPaid` = your partial payment amount
   - Sum of all `amountDue` = remaining balance
7. **Check Sale Details page:**
   - Outstanding debt should match debtor records

## Files Updated

### ✅ Backend (FIXED)
1. **`/routes/warehouse.js`** (lines 1241-1265)
   - ✅ Now properly aggregates debtor amounts from all sales in a receipt
   - ✅ Status calculation uses worst-case priority
   - **Status**: DEPLOYED

### ⚠️ Frontend (STILL NEEDED)
1. **`src/pages/warehouse/CreateSale.tsx`**
   - Change line in `createSaleMutation.mutationFn`
   - Replace `const itemTotal = item.quantity * item.unitPrice;`
   - With `const itemTotal = item.finalTotal;`
   - **Status**: PENDING - Only affects sales with discounts

## Impact

### Backend Fix (Already Applied)
- **Severity**: Critical - Affects ALL multi-item credit sales with partial payments
- **Fixed**: Sale details page now shows correct total amounts
- **Backward Compatibility**: No breaking changes

### Frontend Fix (Still Pending)
- **Severity**: High - Only affects sales with discounts applied
- **Affected**: Customer debt tracking when discounts are involved
- **Risk**: Low - Single line change, well-isolated
- **Backward Compatibility**: Existing incorrect debt records will need manual review/correction

## Additional Recommendations

1. Consider adding validation in the backend to ensure:
   ```javascript
   if (Math.abs(amountPaid + amountDue - totalAmount) > 0.01) {
       throw new ValidationError('Payment amounts do not match total');
   }
   ```

2. Add frontend unit tests for payment allocation logic

3. Consider creating a script to audit and fix existing incorrect debt records

---

**Status**: Ready to implement
**Priority**: High
**Estimated Time**: 5 minutes to fix, 15 minutes to test
**Date**: 2025-12-02
