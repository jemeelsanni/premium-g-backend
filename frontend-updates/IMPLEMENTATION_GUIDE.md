# Warehouse Profitability Frontend Implementation Guide

## Overview
This guide explains how to integrate the new warehouse profitability features into your frontend application.

## Files Updated

### 1. `warehouseService.ts`
**Location**: Your services directory (e.g., `src/services/warehouseService.ts`)

**New Types Added**:
- `WarehouseDashboardSummary` - Enhanced summary with profitability metrics
- `ExpenseBreakdown` - Expense categorization
- `TopProfitableProduct` - Product profitability with expense allocation
- `TopProfitableCustomer` - Customer profitability analysis
- `WarehouseDashboardStatsResponse` - Complete dashboard response type

**Key Changes**:
```typescript
// New fields in summary
summary: {
  // Existing
  totalRevenue, totalCOGS, grossProfit, grossProfitMargin,

  // NEW
  totalExpenses,      // Total approved expenses
  netProfit,          // Gross profit - expenses
  netProfitMargin,    // Net profit as % of revenue
  cogsRatio,          // COGS as % of revenue
  expenseRatio,       // Expenses as % of revenue
  revenuePerCustomer, // Average revenue per customer
  profitPerSale       // Average net profit per sale
}

// New sections
expenseBreakdown: {
  total: number,
  byCategory: { [category: string]: number }
}

topCustomers: TopProfitableCustomer[] // NEW array
```

### 2. `WarehouseDashboard.tsx`
**Location**: Your pages directory (e.g., `src/pages/warehouse/WarehouseDashboard.tsx`)

See the updated component file for the complete implementation.

---

## Implementation Steps

### Step 1: Update Service File
Replace your `warehouseService.ts` with the updated version that includes:
- New profitability types
- Enhanced `getDashboardStats()` return type
- Proper error handling with default profitability values

### Step 2: Update Dashboard Component
The dashboard now displays:

1. **Enhanced Stat Cards** (8 total):
   - Total Sales
   - Total Revenue
   - **Net Profit** (NEW)
   - **Gross Profit Margin** (NEW)
   - **Total Expenses** (NEW)
   - Outstanding Debt
   - Inventory Items
   - Active Customers

2. **Profitability Overview Section** (NEW):
   - Net profit with margin
   - Cost breakdown (COGS vs Expenses vs Profit)
   - Efficiency metrics

3. **Expense Breakdown Card** (NEW):
   - Pie chart or list of expenses by category
   - Total expenses
   - Top expense categories

4. **Top Profitable Customers** (NEW):
   - Table showing most profitable customers
   - Net profit contribution
   - Outstanding debt
   - Order count

5. **Enhanced Top Products**:
   - Now includes net profit (after expense allocation)
   - Net profit margin
   - Allocated expenses

### Step 3: Install Required Dependencies (if needed)
```bash
npm install lucide-react @tanstack/react-query
```

### Step 4: Test the Implementation
1. Verify data fetching works
2. Check that new metrics display correctly
3. Ensure filters work with profitability data
4. Test responsive layout

---

## Key Features

### Profitability Metrics
```typescript
// Access new profitability data
const summary = stats?.data?.summary;

console.log(summary.netProfit);         // Net profit after expenses
console.log(summary.netProfitMargin);   // Net profit %
console.log(summary.totalExpenses);     // Total approved expenses
console.log(summary.cogsRatio);         // COGS as % of revenue
console.log(summary.expenseRatio);      // Expenses as % of revenue
```

### Expense Breakdown
```typescript
const expenseBreakdown = stats?.data?.expenseBreakdown;

console.log(expenseBreakdown.total);    // Total expenses
console.log(expenseBreakdown.byCategory);  // { utilities: 1000, rent: 5000, ... }
```

### Top Customers
```typescript
const topCustomers = stats?.data?.topCustomers || [];

topCustomers.forEach(customer => {
  console.log(customer.customerName);
  console.log(customer.netProfit);      // Customer's net profit contribution
  console.log(customer.netProfitMargin); // Customer's profit margin
  console.log(customer.outstandingDebt); // Debt owed
});
```

### Top Products
```typescript
const topProducts = stats?.data?.topProducts || [];

topProducts.forEach(product => {
  console.log(product.productName);
  console.log(product.netProfit);        // Net profit after expense allocation
  console.log(product.allocatedExpenses); // Proportional expenses
  console.log(product.netProfitMargin);  // Net margin %
});
```

---

## Visual Components

### 1. Profitability Card
```tsx
<div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-6">
  <h3 className="text-lg font-semibold text-green-900">
    Net Profitability
  </h3>
  <div className="mt-2">
    <div className="text-3xl font-bold text-green-700">
      ₦{parseNumber(summary.netProfit).toLocaleString()}
    </div>
    <div className="text-sm text-green-600 mt-1">
      {summary.netProfitMargin.toFixed(2)}% Net Margin
    </div>
  </div>
</div>
```

### 2. Cost Breakdown Chart
```tsx
<div className="space-y-2">
  <div className="flex items-center justify-between">
    <span>COGS</span>
    <span>{summary.cogsRatio.toFixed(1)}%</span>
  </div>
  <div className="w-full bg-gray-200 rounded-full h-2">
    <div
      className="bg-red-500 h-2 rounded-full"
      style={{ width: `${summary.cogsRatio}%` }}
    />
  </div>

  <div className="flex items-center justify-between">
    <span>Expenses</span>
    <span>{summary.expenseRatio.toFixed(1)}%</span>
  </div>
  <div className="w-full bg-gray-200 rounded-full h-2">
    <div
      className="bg-orange-500 h-2 rounded-full"
      style={{ width: `${summary.expenseRatio}%` }}
    />
  </div>

  <div className="flex items-center justify-between">
    <span>Net Profit</span>
    <span>{summary.netProfitMargin.toFixed(1)}%</span>
  </div>
  <div className="w-full bg-gray-200 rounded-full h-2">
    <div
      className="bg-green-500 h-2 rounded-full"
      style={{ width: `${summary.netProfitMargin}%` }}
    />
  </div>
</div>
```

### 3. Expense Breakdown
```tsx
<div className="bg-white rounded-lg shadow p-6">
  <h3 className="text-lg font-semibold mb-4">Expense Breakdown</h3>
  <div className="space-y-3">
    {Object.entries(expenseBreakdown.byCategory).map(([category, amount]) => (
      <div key={category} className="flex justify-between items-center">
        <span className="capitalize text-gray-600">
          {category.replace(/_/g, ' ')}
        </span>
        <span className="font-semibold">
          ₦{parseNumber(amount).toLocaleString()}
        </span>
      </div>
    ))}
  </div>
  <div className="mt-4 pt-4 border-t border-gray-200">
    <div className="flex justify-between items-center font-bold">
      <span>Total Expenses</span>
      <span className="text-red-600">
        ₦{parseNumber(expenseBreakdown.total).toLocaleString()}
      </span>
    </div>
  </div>
</div>
```

---

## API Response Structure

### GET `/api/v1/warehouse/analytics/summary`
```json
{
  "success": true,
  "data": {
    "summary": {
      "totalRevenue": 150000.00,
      "totalCOGS": 90000.00,
      "totalExpenses": 15000.00,
      "grossProfit": 60000.00,
      "netProfit": 45000.00,
      "grossProfitMargin": 40.00,
      "netProfitMargin": 30.00,
      "cogsRatio": 60.00,
      "expenseRatio": 10.00,
      "totalSales": 250,
      "totalQuantitySold": 5000,
      "averageSaleValue": 600.00,
      "revenuePerCustomer": 5000.00,
      "profitPerSale": 180.00,
      "totalCustomers": 30,
      "activeCustomers": 25
    },
    "expenseBreakdown": {
      "total": 15000.00,
      "byCategory": {
        "utilities": 3000.00,
        "rent": 8000.00,
        "supplies": 2500.00,
        "maintenance": 1500.00
      }
    },
    "topProducts": [
      {
        "productName": "Product A",
        "sales": 50,
        "revenue": 30000.00,
        "cogs": 18000.00,
        "quantity": 1000,
        "grossProfit": 12000.00,
        "allocatedExpenses": 3000.00,
        "netProfit": 9000.00,
        "netProfitMargin": 30.00
      }
    ],
    "topCustomers": [
      {
        "customerId": "abc123",
        "customerName": "ABC Corp",
        "orderCount": 15,
        "revenue": 50000.00,
        "cogs": 30000.00,
        "grossProfit": 20000.00,
        "allocatedExpenses": 5000.00,
        "netProfit": 15000.00,
        "netProfitMargin": 30.00,
        "outstandingDebt": 5000.00
      }
    ],
    "cashFlow": { ... },
    "inventory": { ... },
    "debtorSummary": { ... },
    "customerSummary": { ... },
    "dailyPerformance": [ ... ],
    "period": { ... }
  }
}
```

---

## Common Issues & Solutions

### Issue 1: Type Errors
**Problem**: TypeScript errors about missing properties
**Solution**: Ensure you've updated the `WarehouseDashboardStatsResponse` type

### Issue 2: Undefined Values
**Problem**: `Cannot read property 'netProfit' of undefined`
**Solution**: Use optional chaining and provide defaults:
```typescript
const netProfit = stats?.data?.summary?.netProfit ?? 0;
```

### Issue 3: Filter Not Working
**Problem**: Data doesn't update when changing filters
**Solution**: Ensure `filterMonth`, `filterYear`, and `filterType` are in the query key:
```typescript
queryKey: ['warehouse-dashboard', filterMonth, filterYear, filterType]
```

---

## Testing Checklist

- [ ] Dashboard loads without errors
- [ ] All stat cards display correct values
- [ ] Expense breakdown shows categories
- [ ] Top customers table renders
- [ ] Top products include net profit
- [ ] Filters work correctly
- [ ] Period label updates
- [ ] Number formatting is correct
- [ ] Loading states work
- [ ] Error states handled
- [ ] Responsive on mobile
- [ ] Data refreshes properly

---

## Support

For questions or issues:
1. Check the API response in browser DevTools
2. Verify backend endpoints return expected data structure
3. Ensure all dependencies are installed
4. Check console for TypeScript errors

Happy coding! 🚀
