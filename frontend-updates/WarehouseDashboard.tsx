/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
    Package,
    ShoppingCart,
    Users,
    DollarSign,
    Plus,
    ArrowRight,
    AlertCircle,
    AlertTriangle,
    Receipt,
    Percent,
    Filter,
    Calendar,
    X,
    TrendingUp,
    TrendingDown
} from 'lucide-react';
import { warehouseService } from '../../services/warehouseService';
import { LoadingSpinner } from '../../components/ui/LoadingSpinner';
import { Button } from '../../components/ui/Button';
import { Table } from '../../components/ui/Table';
import { WarehouseInventory, WarehouseExpense } from '../../types/warehouse';

export const WarehouseDashboard: React.FC = () => {
    const currentDate = new Date();
    const [filterMonth, setFilterMonth] = useState(currentDate.getMonth() + 1);
    const [filterYear, setFilterYear] = useState(currentDate.getFullYear());
    const [showFilter, setShowFilter] = useState(false);
    const [filterType, setFilterType] = useState<'month' | 'year' | 'all'>('month');

    const getQueryParams = () => {
        if (filterType === 'all') {
            return {};
        } else if (filterType === 'year') {
            return { filterYear };
        } else {
            return { filterMonth, filterYear };
        }
    };

    const { data: stats, isLoading, error } = useQuery({
        queryKey: ['warehouse-dashboard', filterMonth, filterYear, filterType],
        queryFn: () => warehouseService.getDashboardStats(getQueryParams()),
    });

    const { data: recentSales } = useQuery({
        queryKey: ['warehouse-sales', 1, 5],
        queryFn: () => warehouseService.getSales(1, 5),
        select: (data) => ({
            data: {
                sales: data?.data?.sales || []
            }
        })
    });

    const { data: lowStockItems } = useQuery({
        queryKey: ['warehouse-inventory-low-stock'],
        queryFn: () => warehouseService.getInventory(1, 10),
    });

    const { data: customersList } = useQuery({
        queryKey: ['warehouse-customers-count'],
        queryFn: () => warehouseService.getCustomers(1, 1000),
        select: (response) => {
            const customers = response?.data?.customers || [];
            const pagination = response?.data?.pagination;
            return {
                customers,
                total: pagination?.total ?? customers.length,
                active: customers.filter((customer) => customer.isActive ?? true).length
            };
        }
    });

    const { data: expensesData, isLoading: expensesLoading } = useQuery({
        queryKey: ['warehouse-expenses-dashboard', 1, 5],
        queryFn: () => warehouseService.getExpenses({ page: 1, limit: 5 }),
    });

    const { data: expiringData } = useQuery({
        queryKey: ['warehouse-expiring-purchases-dashboard'],
        queryFn: () => warehouseService.getExpiringPurchases(),
        refetchInterval: 60000,
    });

    const parseNumber = (value: unknown, fallback = 0) => {
        if (typeof value === 'number') {
            return Number.isFinite(value) ? value : fallback;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-64">
                <LoadingSpinner size="lg" />
            </div>
        );
    }

    const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const yearOptions = Array.from(
        { length: 6 },
        (_, i) => currentDate.getFullYear() - 2 + i
    );

    const resetToCurrentMonth = () => {
        setFilterMonth(currentDate.getMonth() + 1);
        setFilterYear(currentDate.getFullYear());
        setFilterType('month');
    };

    const getPeriodLabel = () => {
        if (filterType === 'all') return 'All Time';
        if (filterType === 'year') return `Year ${filterYear}`;
        return `${monthNames[filterMonth - 1]} ${filterYear}`;
    };

    if (error) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="text-center">
                    <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
                    <p className="text-gray-600">Failed to load dashboard data</p>
                </div>
            </div>
        );
    }

    const summary = (stats?.data?.summary ?? stats?.summary ?? {}) as Record<string, unknown>;
    const inventorySummary = (stats?.data?.inventory ?? stats?.inventory ?? {}) as Record<string, unknown>;
    const customerSummary = (stats?.data?.customerSummary ?? stats?.customerSummary ?? {}) as Record<string, unknown>;
    const debtorSummary = (stats?.data?.debtorSummary ?? {}) as Record<string, unknown>;
    const expenseBreakdown = (stats?.data?.expenseBreakdown ?? { total: 0, byCategory: {} }) as { total: number; byCategory: Record<string, number> };

    const safeSummaryNumber = (key: string, fallback = 0) => parseNumber(summary[key], fallback);

    const lowStockRaw = lowStockItems?.data;
    const fallbackInventoryCount = Array.isArray(lowStockRaw)
        ? lowStockRaw.length
        : Array.isArray((lowStockRaw as any)?.inventory)
            ? (lowStockRaw as any).inventory.length
            : 0;

    const totalInventoryItems = parseNumber(
        (inventorySummary as { totalItems?: unknown })?.totalItems,
        fallbackInventoryCount
    );

    const activeCustomerCount = parseNumber(
        (customerSummary as { activeCustomers?: unknown })?.activeCustomers
        ?? (summary as { activeCustomers?: unknown })?.activeCustomers,
        customersList?.active ?? 0
    );

    const totalOutstanding = parseNumber(
        (debtorSummary as { totalOutstanding?: unknown })?.totalOutstanding,
        0
    );

    const summarizeSaleProducts = (sale: any) => {
        const items = Array.isArray(sale?.items) ? sale.items : [];
        if (items.length === 0) {
            return 'No products';
        }
        const firstName = items[0]?.product?.name || 'Unknown Product';
        if (items.length === 1) {
            return firstName;
        }
        return `${firstName} (+${items.length - 1} more)`;
    };

    // 🆕 UPDATED: Enhanced stat cards with profitability metrics
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
            subtitle: `${parseNumber(debtorSummary.totalDebtors)} debtor${parseNumber(debtorSummary.totalDebtors) !== 1 ? 's' : ''}`
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

    const salesColumns = [
        {
            key: 'receiptNumber',
            title: 'Record',
            render: (value: string) => (value ? <span className="font-mono text-xs text-gray-600">{value}</span> : '—')
        },
        {
            key: 'customerName',
            title: 'Customer',
            render: (value: string) => value || 'Walk-in Customer'
        },
        {
            key: 'items',
            title: 'Products',
            render: (_value: any, record: any) => summarizeSaleProducts(record)
        },
        {
            key: 'totalAmount',
            title: 'Total',
            render: (value: number | null | undefined) => {
                const amount = typeof value === 'number' ? value : Number(value || 0);
                return `₦${amount.toLocaleString()}`;
            }
        },
        {
            key: 'createdAt',
            title: 'Date',
            render: (value: string) => (value ? new Date(value).toLocaleDateString() : 'N/A')
        }
    ];

    const lowStockColumns = [
        {
            key: 'product',
            title: 'Product',
            render: (value: any) => value?.name || 'Unknown Product'
        },
        {
            key: 'currentStock',
            title: 'Current Stock',
            render: (value: number | undefined) => (
                <span className="text-red-600 font-medium">
                    {typeof value === 'number' ? value.toLocaleString() : '0'}
                </span>
            )
        },
        {
            key: 'minimumStock',
            title: 'Minimum Stock',
            render: (value: number | undefined) => (
                typeof value === 'number' ? value.toLocaleString() : '0'
            )
        },
        {
            key: 'actions',
            title: 'Actions',
            render: (_value: any, _record: any) => (
                <Link to={`/warehouse/inventory`}>
                    <Button size="sm" variant="outline">
                        Restock
                    </Button>
                </Link>
            )
        }
    ];

    const rawLowStockData = lowStockItems?.data;
    const lowStockInventory = Array.isArray(rawLowStockData)
        ? rawLowStockData
        : Array.isArray((rawLowStockData as any)?.inventory)
            ? (rawLowStockData as any).inventory
            : [];

    const normalizedLowStock: WarehouseInventory[] = lowStockInventory.map((item: any) => {
        const currentStock = parseNumber(item.currentStock ?? item.packs ?? item.units ?? 0);
        const minimumStock = parseNumber(item.minimumStock ?? item.reorderLevel ?? 0);

        return {
            ...item,
            currentStock,
            minimumStock,
        } as WarehouseInventory;
    });

    const lowStock = normalizedLowStock.filter(item => {
        const current = parseNumber(item.currentStock);
        const minimum = parseNumber(item.minimumStock);
        return current <= minimum;
    });

    const recentExpenses: WarehouseExpense[] = expensesData?.data?.expenses || [];

    const expenseColumns = [
        {
            key: 'description',
            title: 'Description',
            render: (_value: string | undefined, record: WarehouseExpense) => (
                <div>
                    <div className="font-medium text-gray-900">
                        {record.description || record.category || 'Expense'}
                    </div>
                    <div className="text-xs text-gray-500">
                        {record.product?.name ? `Product: ${record.product.name}` : 'General expense'}
                    </div>
                </div>
            )
        },
        {
            key: 'amount',
            title: 'Amount',
            render: (value: number | string) => {
                const amountValue = parseNumber(value);
                return <span className="font-semibold text-gray-900">₦{amountValue.toLocaleString()}</span>;
            }
        },
        {
            key: 'status',
            title: 'Status',
            render: (value: WarehouseExpense['status']) => {
                const badgeClasses: Record<WarehouseExpense['status'], string> = {
                    PENDING: 'bg-yellow-100 text-yellow-800',
                    APPROVED: 'bg-green-100 text-green-800',
                    REJECTED: 'bg-red-100 text-red-800',
                    PAID: 'bg-blue-100 text-blue-800'
                };
                return (
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badgeClasses[value]}`}>
                        {value}
                    </span>
                );
            }
        },
        {
            key: 'createdAt',
            title: 'Date',
            render: (value: string) => new Date(value).toLocaleDateString()
        }
    ];

    return (
        <div className="space-y-6">
            {/* Header with Filter */}
            <div className="md:flex md:items-center md:justify-between">
                <div className="flex-1 min-w-0">
                    <h2 className="text-2xl font-bold leading-7 text-gray-900 sm:text-3xl sm:truncate">
                        Warehouse Dashboard
                    </h2>
                    <p className="mt-1 text-sm text-gray-500">
                        Showing data for: <span className="font-semibold text-gray-700">{getPeriodLabel()}</span>
                    </p>
                </div>
                <div className="mt-4 flex md:mt-0 md:ml-4 space-x-3">
                    <Button
                        onClick={() => setShowFilter(!showFilter)}
                        variant="outline"
                        className="inline-flex items-center"
                    >
                        <Filter className="h-4 w-4 mr-2" />
                        {showFilter ? 'Hide Filter' : 'Filter Period'}
                    </Button>
                    <Link to="/warehouse/sales/create">
                        <Button className="inline-flex items-center">
                            <Plus className="h-4 w-4 mr-2" />
                            Record Sale
                        </Button>
                    </Link>
                    <Link to="/warehouse/customers">
                        <Button variant="outline">
                            Manage Customers
                        </Button>
                    </Link>
                </div>
            </div>

            {/* Filter Panel */}
            {showFilter && (
                <div className="bg-white shadow rounded-lg p-6 border-l-4 border-blue-500">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-lg font-medium text-gray-900">Filter by Period</h3>
                        <button
                            onClick={() => setShowFilter(false)}
                            className="text-gray-400 hover:text-gray-500"
                        >
                            <X className="h-5 w-5" />
                        </button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Filter Type
                            </label>
                            <select
                                value={filterType}
                                onChange={(e) => setFilterType(e.target.value as any)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                                <option value="month">Specific Month</option>
                                <option value="year">Entire Year</option>
                                <option value="all">All Time</option>
                            </select>
                        </div>

                        {filterType === 'month' && (
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Month
                                </label>
                                <select
                                    value={filterMonth}
                                    onChange={(e) => setFilterMonth(parseInt(e.target.value))}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                >
                                    {monthNames.map((month, idx) => (
                                        <option key={idx} value={idx + 1}>
                                            {month}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {(filterType === 'month' || filterType === 'year') && (
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Year
                                </label>
                                <select
                                    value={filterYear}
                                    onChange={(e) => setFilterYear(parseInt(e.target.value))}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                >
                                    {yearOptions.map((year) => (
                                        <option key={year} value={year}>
                                            {year}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        <div className="flex items-end">
                            <Button
                                onClick={resetToCurrentMonth}
                                variant="outline"
                                className="w-full"
                            >
                                <Calendar className="h-4 w-4 mr-2" />
                                Current Month
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Low Stock Alert */}
            {lowStock.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <div className="flex items-center">
                        <AlertTriangle className="h-5 w-5 text-red-400 mr-3" />
                        <div>
                            <h3 className="text-sm font-medium text-red-800">
                                Low Stock Alert
                            </h3>
                            <div className="mt-1 text-sm text-red-700">
                                {lowStock.length} item(s) are running low on stock and need restocking.
                                <Link to="/warehouse/inventory" className="font-medium underline ml-1">
                                    View inventory →
                                </Link>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Expiring Products Alert */}
            {expiringData && expiringData.data.count > 0 && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                    <div className="flex items-start space-x-3">
                        <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
                        <div className="flex-1">
                            <h3 className="text-sm font-medium text-yellow-900">
                                Expiry Alert: {expiringData.data.count} product batch(es) expiring soon
                            </h3>
                            <p className="text-sm text-yellow-700 mt-1">
                                Some products are within 30 days of expiry. Please check the affected batches.
                            </p>
                            <Link
                                to="/warehouse/offload-purchases"
                                className="mt-2 inline-flex items-center text-sm font-medium text-yellow-800 underline"
                            >
                                View Expiring Products
                            </Link>
                        </div>
                    </div>
                </div>
            )}

            {/* Stats Cards */}
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
                {statCards.map((stat, index) => (
                    <div key={index} className="bg-white overflow-hidden shadow rounded-lg">
                        <div className="p-5">
                            <div className="flex items-center">
                                <div className="flex-shrink-0">
                                    <stat.icon className={`h-8 w-8 text-${stat.color}-600`} />
                                </div>
                                <div className="ml-5 w-0 flex-1">
                                    <dl>
                                        <dt className="text-sm font-medium text-gray-500 truncate">
                                            {stat.title}
                                        </dt>
                                        <dd className="flex items-baseline">
                                            <div className="text-2xl font-semibold text-gray-900">
                                                {stat.value}
                                            </div>
                                        </dd>
                                        {stat.subtitle && (
                                            <dd className="text-xs text-gray-500 mt-1">
                                                {stat.subtitle}
                                            </dd>
                                        )}
                                    </dl>
                                </div>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

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

            {/* Quick Actions */}
            <div className="bg-white shadow rounded-lg">
                <div className="p-6">
                    <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
                        Quick Actions
                    </h3>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
                        <Link
                            to="/warehouse/sales/create"
                            className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
                        >
                            <div>
                                <span className="rounded-lg inline-flex p-3 bg-blue-50 text-blue-600 group-hover:bg-blue-100">
                                    <ShoppingCart className="h-6 w-6" />
                                </span>
                            </div>
                            <div className="mt-4">
                                <h3 className="text-lg font-medium text-gray-900">
                                    Record Sale
                                </h3>
                                <p className="mt-2 text-sm text-gray-500">
                                    Record a new warehouse sale
                                </p>
                            </div>
                            <span className="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400">
                                <ArrowRight className="h-6 w-6" />
                            </span>
                        </Link>

                        <Link
                            to="/warehouse/inventory"
                            className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
                        >
                            <div>
                                <span className="rounded-lg inline-flex p-3 bg-purple-50 text-purple-600 group-hover:bg-purple-100">
                                    <Package className="h-6 w-6" />
                                </span>
                            </div>
                            <div className="mt-4">
                                <h3 className="text-lg font-medium text-gray-900">
                                    Manage Inventory
                                </h3>
                                <p className="mt-2 text-sm text-gray-500">
                                    View and update stock levels
                                </p>
                            </div>
                            <span className="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400">
                                <ArrowRight className="h-6 w-6" />
                            </span>
                        </Link>

                        <Link
                            to="/warehouse/customers"
                            className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
                        >
                            <div>
                                <span className="rounded-lg inline-flex p-3 bg-green-50 text-green-600 group-hover:bg-green-100">
                                    <Users className="h-6 w-6" />
                                </span>
                            </div>
                            <div className="mt-4">
                                <h3 className="text-lg font-medium text-gray-900">
                                    Customer Database
                                </h3>
                                <p className="mt-2 text-sm text-gray-500">
                                    Manage warehouse customers
                                </p>
                            </div>
                            <span className="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400">
                                <ArrowRight className="h-6 w-6" />
                            </span>
                        </Link>

                        <Link
                            to="/warehouse/cash-flow"
                            className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
                        >
                            <div>
                                <span className="rounded-lg inline-flex p-3 bg-orange-50 text-orange-600 group-hover:bg-orange-100">
                                    <DollarSign className="h-6 w-6" />
                                </span>
                            </div>
                            <div className="mt-4">
                                <h3 className="text-lg font-medium text-gray-900">
                                    Cash Flow
                                </h3>
                                <p className="mt-2 text-sm text-gray-500">
                                    Monitor cash flow operations
                                </p>
                            </div>
                            <span className="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400">
                                <ArrowRight className="h-6 w-6" />
                            </span>
                        </Link>

                        <Link
                            to="/warehouse/expenses"
                            className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
                        >
                            <div>
                                <span className="rounded-lg inline-flex p-3 bg-rose-50 text-rose-600 group-hover:bg-rose-100">
                                    <Receipt className="h-6 w-6" />
                                </span>
                            </div>
                            <div className="mt-4">
                                <h3 className="text-lg font-medium text-gray-900">
                                    Warehouse Expenses
                                </h3>
                                <p className="mt-2 text-sm text-gray-500">
                                    Review and track spend history
                                </p>
                            </div>
                            <span className="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400">
                                <ArrowRight className="h-6 w-6" />
                            </span>
                        </Link>

                        <Link
                            to="/warehouse/discounts"
                            className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
                        >
                            <div>
                                <span className="rounded-lg inline-flex p-3 bg-indigo-50 text-indigo-600 group-hover:bg-indigo-100">
                                    <Percent className="h-6 w-6" />
                                </span>
                            </div>
                            <div className="mt-4">
                                <h3 className="text-lg font-medium text-gray-900">
                                    Discount Requests
                                </h3>
                                <p className="mt-2 text-sm text-gray-500">
                                    Review and approve warehouse discounts
                                </p>
                            </div>
                            <span className="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400">
                                <ArrowRight className="h-6 w-6" />
                            </span>
                        </Link>

                        <Link
                            to="/warehouse/debtors"
                            className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
                        >
                            <div>
                                <span className="rounded-lg inline-flex p-3 bg-indigo-50 text-indigo-600 group-hover:bg-indigo-100">
                                    <AlertCircle className="h-6 w-6" />
                                </span>
                            </div>
                            <div className="mt-4">
                                <h3 className="text-lg font-medium text-gray-900">
                                    Warehouse Debtors
                                </h3>
                                <p className="mt-2 text-sm text-gray-500">
                                    Review and update warehouse debtors
                                </p>
                            </div>
                            <span className="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400">
                                <ArrowRight className="h-6 w-6" />
                            </span>
                        </Link>

                        <Link
                            to="/warehouse/offload-purchases"
                            className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
                        >
                            <div>
                                <span className="rounded-lg inline-flex p-3 bg-indigo-50 text-indigo-600 group-hover:bg-indigo-100">
                                    <Package className="h-6 w-6" />
                                </span>
                            </div>
                            <div className="mt-4">
                                <h3 className="text-lg font-medium text-gray-900">
                                    Warehouse Purchases
                                </h3>
                                <p className="mt-2 text-sm text-gray-500">
                                    Record warehouse purchases
                                </p>
                            </div>
                            <span className="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400">
                                <ArrowRight className="h-6 w-6" />
                            </span>
                        </Link>

                        <Link
                            to="/warehouse/daily-opening-stock"
                            className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
                        >
                            <div>
                                <span className="rounded-lg inline-flex p-3 bg-indigo-50 text-indigo-600 group-hover:bg-indigo-100">
                                    <Calendar className="h-6 w-6" />
                                </span>
                            </div>
                            <div className="mt-4">
                                <h3 className="text-lg font-medium text-gray-900">
                                    Daily Opening Stock
                                </h3>
                                <p className="mt-2 text-sm text-gray-500">
                                    Record daily opening stock
                                </p>
                            </div>
                            <span className="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400">
                                <ArrowRight className="h-6 w-6" />
                            </span>
                        </Link>

                        <Link
                            to="/warehouse/expiring-products"
                            className="relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
                        >
                            <div>
                                <span className="rounded-lg inline-flex p-3 bg-indigo-50 text-indigo-600 group-hover:bg-indigo-100">
                                    <AlertTriangle className="h-6 w-6" />
                                </span>
                            </div>
                            <div className="mt-4">
                                <h3 className="text-lg font-medium text-gray-900">
                                    Expired products
                                </h3>
                                <p className="mt-2 text-sm text-gray-500">
                                    View expired products
                                </p>
                            </div>
                            <span className="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400">
                                <ArrowRight className="h-6 w-6" />
                            </span>
                        </Link>
                    </div>
                </div>
            </div>

            {/* Data Grid with Expense Breakdown and Top Customers */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
                {/* Recent Sales */}
                <div className="bg-white shadow rounded-lg">
                    <div className="px-6 py-4 border-b border-gray-200">
                        <div className="flex items-center justify-between">
                            <h3 className="text-lg leading-6 font-medium text-gray-900">
                                Recent Sales
                            </h3>
                            <Link
                                to="/warehouse/sales"
                                className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                            >
                                View all sales
                            </Link>
                        </div>
                    </div>
                    <div className="p-6">
                        <Table
                            data={recentSales?.data?.sales || []}
                            columns={salesColumns}
                            loading={!recentSales}
                            emptyMessage="No recent sales found"
                        />
                    </div>
                </div>

                {/* Low Stock Items */}
                <div className="bg-white shadow rounded-lg">
                    <div className="px-6 py-4 border-b border-gray-200">
                        <div className="flex items-center justify-between">
                            <h3 className="text-lg leading-6 font-medium text-gray-900 flex items-center">
                                <AlertTriangle className="h-5 w-5 text-red-500 mr-2" />
                                Low Stock Items
                            </h3>
                            <Link
                                to="/warehouse/inventory"
                                className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                            >
                                View inventory
                            </Link>
                        </div>
                    </div>
                    <div className="p-6">
                        <Table
                            data={lowStock}
                            columns={lowStockColumns}
                            loading={!lowStockItems}
                            emptyMessage="All items are well stocked"
                        />
                    </div>
                </div>

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

                {/* Recent Expenses */}
                <div className="bg-white shadow rounded-lg xl:col-span-2">
                    <div className="px-6 py-4 border-b border-gray-200">
                        <div className="flex items-center justify-between">
                            <h3 className="text-lg leading-6 font-medium text-gray-900">
                                Recent Expenses
                            </h3>
                            <Link
                                to="/warehouse/expenses"
                                className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                            >
                                View details
                            </Link>
                        </div>
                    </div>
                    <div className="p-6">
                        <Table
                            data={recentExpenses}
                            columns={expenseColumns}
                            loading={expensesLoading}
                            emptyMessage="No expenses recorded yet"
                        />
                    </div>
                </div>

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
            </div>
        </div>
    );
};
