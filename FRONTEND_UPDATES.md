# Frontend Updates for Per-Sale Debtor Display

## Updated TypeScript Interfaces

Replace the `AggregatedDebtor` interface with this new structure:

```typescript
// Updated interface to match new backend per-sale structure
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

## Service Method Updates

In your `warehouseService.ts`, update the `recordDebtorPayment` method:

```typescript
// Update this method - now payments go to individual debtor/sale
async recordDebtorPayment(debtorId: string, data: RecordPaymentData): Promise<any> {
    return this.post(data, `/debtors/${debtorId}/payments`);
}

// Remove or keep for customer-wide payments (optional)
async recordCustomerDebtPayment(customerId: string, data: RecordPaymentData): Promise<any> {
    return this.post(data, `/debtors/customer/${customerId}/payment`);
}
```

## Component Updates

See DEBTOR_DASHBOARD_UPDATED.tsx for the complete updated component code.

### Key Changes:

1. **No more customer grouping** - Each row is a sale/receipt
2. **Payment per sale** - Users pay individual sale debts
3. **Simplified display** - Direct list of sales with debt info
4. **Receipt-based navigation** - Each item links to its receipt

### Migration Notes:

- The backend now returns flat list of debtors (one per sale)
- No more `debtCount`, `earliestDueDate`, `allPayments` aggregation
- Payment flows target individual `debtorId` not `customerId`
- Pagination and filtering still work the same way
