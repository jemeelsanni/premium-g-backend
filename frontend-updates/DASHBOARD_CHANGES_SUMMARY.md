# Warehouse Dashboard Component Changes

## Summary of Changes

The dashboard component needs the following updates to display the new profitability metrics:

---

## 1. Update Stat Cards Array

Replace the `statCards` array to include new profitability metrics:

```typescript
const statCards = [
  {
    title: 'Total Sales',
    value: safeSummaryNumber('totalSales'),
    icon: ShoppingCart,
    color: 'blue',
    subtitle: `${safeSummaryNumber('totalQuantitySold').toLocaleString()} items sold`
  },
  {
    title: 'Total Revenue',
    value: `₦${safeSummaryNumber('totalRevenue').toLocaleString()}`,
    icon: DollarSign,
    color: 'green',
    subtitle: `Avg: ₦${safeSummaryNumber('averageSaleValue').toLocaleString()}/sale`
  },
  // 🆕 NEW
  {
    title: 'Net Profit',
    value: `₦${safeSummaryNumber('netProfit').toLocaleString()}`,
    icon: TrendingUp,
    color: 'emerald',
    subtitle: `${safeSummaryNumber('netProfitMargin').toFixed(1)}% margin`
  },
  // 🆕 NEW
  {
    title: 'Gross Margin',
    value: `${safeSummaryNumber('grossProfitMargin').toFixed(1)}%`,
    icon: Percent,
    color: 'blue',
    subtitle: `₦${safeSummaryNumber('grossProfit').toLocaleString()} profit`
  },
  // 🆕 NEW
  {
    title: 'Total Expenses',
    value: `₦${safeSummaryNumber('totalExpenses').toLocaleString()}`,
    icon: Receipt,
    color: 'red',
    subtitle: `${safeSummaryNumber('expenseRatio').toFixed(1)}% of revenue`
  },
  {
    title: 'Outstanding Debt',
    value: `₦${totalOutstanding.toLocaleString()}`,
    icon: AlertCircle,
    color: 'orange',
    subtitle: `${parseNumber(debtorSummary.totalDebtors)} debtors`
  },
  {
    title: 'Inventory Items',
    value: totalInventoryItems,
    icon: Package,
    color: 'purple',
    subtitle: `₦${parseNumber(inventorySummary.totalStockValue).toLocaleString()} value`
  },
  {
    title: 'Active Customers',
    value: activeCustomerCount,
    icon: Users,
    color: 'indigo',
    subtitle: `₦${safeSummaryNumber('revenuePerCustomer').toLocaleString()}/customer`
  }
];
```

**New icons needed**:
```typescript
import { TrendingUp, Percent } from 'lucide-react';
```

---

## 2. Add Profitability Overview Section

Add this new section after the stat cards:

```typescript
{/* 🆕 NEW: Profitability Overview */}
<div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-lg shadow-lg p-6 border-l-4 border-green-500">
  <div className="flex items-center justify-between mb-6">
    <h3 className="text-xl font-bold text-gray-900 flex items-center">
      <TrendingUp className="h-6 w-6 mr-2 text-green-600" />
      Profitability Analysis
    </h3>
    <span className="text-sm text-gray-600">{getPeriodLabel()}</span>
  </div>

  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
    {/* Net Profit Card */}
    <div className="bg-white rounded-lg p-4 shadow">
      <div className="text-sm text-gray-600 mb-1">Net Profit</div>
      <div className="text-2xl font-bold text-green-600">
        ₦{safeSummaryNumber('netProfit').toLocaleString()}
      </div>
      <div className="text-xs text-gray-500 mt-1">
        {safeSummaryNumber('netProfitMargin').toFixed(2)}% margin
      </div>
      <div className="text-xs text-gray-400 mt-2">
        ₦{safeSummaryNumber('profitPerSale').toLocaleString()} per sale
      </div>
    </div>

    {/* Cost Breakdown */}
    <div className="bg-white rounded-lg p-4 shadow">
      <div className="text-sm text-gray-600 mb-3">Cost Structure</div>
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600">COGS</span>
          <span className="font-semibold text-red-600">
            {safeSummaryNumber('cogsRatio').toFixed(1)}%
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-red-500 h-2 rounded-full transition-all"
            style={{ width: `${safeSummaryNumber('cogsRatio')}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600">Expenses</span>
          <span className="font-semibold text-orange-600">
            {safeSummaryNumber('expenseRatio').toFixed(1)}%
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-orange-500 h-2 rounded-full transition-all"
            style={{ width: `${safeSummaryNumber('expenseRatio')}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600">Profit</span>
          <span className="font-semibold text-green-600">
            {safeSummaryNumber('netProfitMargin').toFixed(1)}%
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-green-500 h-2 rounded-full transition-all"
            style={{ width: `${safeSummaryNumber('netProfitMargin')}%` }}
          />
        </div>
      </div>
    </div>

    {/* P&L Summary */}
    <div className="bg-white rounded-lg p-4 shadow">
      <div className="text-sm text-gray-600 mb-3">P&L Summary</div>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-600">Revenue</span>
          <span className="font-semibold">
            ₦{safeSummaryNumber('totalRevenue').toLocaleString()}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">COGS</span>
          <span className="text-red-600">
            -₦{safeSummaryNumber('totalCOGS').toLocaleString()}
          </span>
        </div>
        <div className="flex justify-between border-t border-gray-200 pt-2">
          <span className="text-gray-600">Gross Profit</span>
          <span className="font-semibold">
            ₦{safeSummaryNumber('grossProfit').toLocaleString()}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600">Expenses</span>
          <span className="text-orange-600">
            -₦{safeSummaryNumber('totalExpenses').toLocaleString()}
          </span>
        </div>
        <div className="flex justify-between border-t-2 border-green-500 pt-2 font-bold">
          <span className="text-gray-900">Net Profit</span>
          <span className="text-green-600">
            ₦{safeSummaryNumber('netProfit').toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  </div>
</div>
```

---

## 3. Add Expense Breakdown Section

Add this new section in the grid with recent sales and low stock:

```typescript
{/* 🆕 NEW: Expense Breakdown */}
<div className="bg-white shadow rounded-lg">
  <div className="px-6 py-4 border-b border-gray-200">
    <div className="flex items-center justify-between">
      <h3 className="text-lg leading-6 font-medium text-gray-900 flex items-center">
        <Receipt className="h-5 w-5 text-orange-500 mr-2" />
        Expense Breakdown
      </h3>
      <Link
        to="/warehouse/expenses"
        className="text-sm text-blue-600 hover:text-blue-800 font-medium"
      >
        View all expenses
      </Link>
    </div>
  </div>
  <div className="p-6">
    {(() => {
      const expenseBreakdown = stats?.data?.expenseBreakdown;
      const categories = expenseBreakdown?.byCategory || {};
      const totalExpenses = expenseBreakdown?.total || 0;

      if (totalExpenses === 0) {
        return (
          <div className="text-center text-gray-500 py-8">
            No expenses recorded for this period
          </div>
        );
      }

      return (
        <div className="space-y-3">
          {Object.entries(categories)
            .sort((a, b) => parseNumber(b[1]) - parseNumber(a[1]))
            .map(([category, amount]) => {
              const percentage = totalExpenses > 0
                ? (parseNumber(amount) / totalExpenses) * 100
                : 0;

              return (
                <div key={category} className="space-y-1">
                  <div className="flex justify-between items-center text-sm">
                    <span className="capitalize text-gray-600">
                      {category.replace(/_/g, ' ')}
                    </span>
                    <div className="flex items-center space-x-3">
                      <span className="text-gray-500">
                        {percentage.toFixed(1)}%
                      </span>
                      <span className="font-semibold text-gray-900 w-24 text-right">
                        ₦{parseNumber(amount).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-orange-500 h-2 rounded-full transition-all"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}

          <div className="mt-4 pt-4 border-t border-gray-200">
            <div className="flex justify-between items-center font-bold">
              <span className="text-gray-900">Total Expenses</span>
              <span className="text-red-600 text-lg">
                ₦{parseNumber(totalExpenses).toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      );
    })()}
  </div>
</div>
```

---

## 4. Add Top Customers Section

Add this new section in the grid:

```typescript
{/* 🆕 NEW: Top Profitable Customers */}
<div className="bg-white shadow rounded-lg xl:col-span-2">
  <div className="px-6 py-4 border-b border-gray-200">
    <div className="flex items-center justify-between">
      <h3 className="text-lg leading-6 font-medium text-gray-900 flex items-center">
        <Users className="h-5 w-5 text-indigo-500 mr-2" />
        Top Profitable Customers
      </h3>
      <Link
        to="/warehouse/customers"
        className="text-sm text-blue-600 hover:text-blue-800 font-medium"
      >
        View all customers
      </Link>
    </div>
  </div>
  <div className="p-6">
    {(() => {
      const topCustomers = stats?.data?.topCustomers || [];

      if (topCustomers.length === 0) {
        return (
          <div className="text-center text-gray-500 py-8">
            No customer profitability data available
          </div>
        );
      }

      const customerColumns = [
        {
          key: 'customerName',
          title: 'Customer',
          render: (value: string, record: any) => (
            <div>
              <div className="font-medium text-gray-900">{value}</div>
              <div className="text-xs text-gray-500">
                {record.orderCount} order{record.orderCount !== 1 ? 's' : ''}
              </div>
            </div>
          )
        },
        {
          key: 'revenue',
          title: 'Revenue',
          render: (value: number) => (
            <span className="text-gray-900">
              ₦{parseNumber(value).toLocaleString()}
            </span>
          )
        },
        {
          key: 'netProfit',
          title: 'Net Profit',
          render: (value: number, record: any) => (
            <div>
              <div className="font-semibold text-green-600">
                ₦{parseNumber(value).toLocaleString()}
              </div>
              <div className="text-xs text-gray-500">
                {parseNumber(record.netProfitMargin).toFixed(1)}% margin
              </div>
            </div>
          )
        },
        {
          key: 'outstandingDebt',
          title: 'Debt',
          render: (value: number) => {
            const debt = parseNumber(value);
            if (debt === 0) {
              return <span className="text-gray-400">None</span>;
            }
            return (
              <span className="text-orange-600 font-medium">
                ₦{debt.toLocaleString()}
              </span>
            );
          }
        }
      ];

      return <Table data={topCustomers} columns={customerColumns} />;
    })()}
  </div>
</div>
```

---

## 5. Update Grid Layout

Update the grid that contains recent sales, low stock, and expenses to include the new sections:

```typescript
<div className="grid grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
  {/* Recent Sales */}
  <div className="bg-white shadow rounded-lg">...</div>

  {/* Low Stock Items */}
  <div className="bg-white shadow rounded-lg">...</div>

  {/* 🆕 NEW: Expense Breakdown */}
  <div className="bg-white shadow rounded-lg">...</div>

  {/* Recent Expenses - Move to span 2 columns on XL screens */}
  <div className="bg-white shadow rounded-lg xl:col-span-2">...</div>

  {/* 🆕 NEW: Top Customers */}
  <div className="bg-white shadow rounded-lg xl:col-span-2">...</div>
</div>
```

---

## 6. Add Helper Function

Add this helper function for safe number parsing (if not already present):

```typescript
const parseNumber = (value: unknown, fallback = 0) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const safeSummaryNumber = (key: string, fallback = 0) => parseNumber(summary[key], fallback);
```

---

## 7. Update Imports

Add these imports at the top:

```typescript
import {
  // ... existing imports
  TrendingUp,
  Percent,
  // ... rest of imports
} from 'lucide-react';
```

---

## Complete File Structure

After all changes, your dashboard should have this structure:

```
WarehouseDashboard
├── Header with Filter
├── Filter Panel (conditional)
├── Low Stock Alert
├── Expiring Products Alert
├── Stat Cards (8 cards)
├── 🆕 Profitability Overview Section
├── Quick Actions Grid
└── Data Grid
    ├── Recent Sales
    ├── Low Stock Items
    ├── 🆕 Expense Breakdown
    ├── Recent Expenses (2 col span)
    └── 🆕 Top Profitable Customers (2 col span)
```

---

## Testing

After implementing these changes:

1. Check that all 8 stat cards display
2. Verify profitability overview shows correct calculations
3. Ensure expense breakdown displays categories
4. Confirm top customers table renders
5. Test with empty data (should show placeholder messages)
6. Verify filters update all sections
7. Check responsive layout on mobile/tablet

---

## Additional Enhancements (Optional)

### 1. Profit Trend Chart
Add a line chart showing profit trend over time using the `dailyPerformance` data

### 2. Export Functionality
Add export buttons for profitability reports

### 3. Comparison View
Show month-over-month or year-over-year comparisons

### 4. Alerts
Add warnings when profit margins fall below thresholds

---

## Notes

- All monetary values use ₦ (Naira) symbol
- Percentages are formatted to 1-2 decimal places
- Numbers use `.toLocaleString()` for thousands separators
- Colors: Green for profit, Red for costs, Orange for expenses
- Use optional chaining (`?.`) for safe property access
