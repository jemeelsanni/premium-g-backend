/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronUp, CreditCard, Receipt, User, Package } from 'lucide-react';
import { warehouseService } from '../../services/warehouseService';

// ✅ FINAL: Receipt-grouped debtor structure
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

interface DebtorAnalytics {
    [key: string]: {
        count: number;
        totalAmount: number;
        amountPaid: number;
        amountDue: number;
    };
}

const DebtorsDashboard: React.FC = () => {
    const [debtors, setDebtors] = useState<DebtorReceipt[]>([]);
    const [analytics, setAnalytics] = useState<DebtorAnalytics | null>(null);
    const [selectedStatus, setSelectedStatus] = useState<'all' | 'OUTSTANDING' | 'PARTIAL' | 'OVERDUE' | 'PAID'>('all');
    const [loading, setLoading] = useState(true);
    const [expandedReceipts, setExpandedReceipts] = useState<Set<string>>(new Set());
    const [pagination, setPagination] = useState({
        page: 1,
        limit: 20,
        total: 0,
        pages: 0
    });

    // Payment Modal State
    const [showPaymentModal, setShowPaymentModal] = useState(false);
    const [selectedReceipt, setSelectedReceipt] = useState<DebtorReceipt | null>(null);
    const [paymentAmount, setPaymentAmount] = useState('');
    const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD' | 'MOBILE_MONEY'>('CASH');
    const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
    const [paymentReference, setPaymentReference] = useState('');
    const [paymentNotes, setPaymentNotes] = useState('');
    const [processingPayment, setProcessingPayment] = useState(false);

    const fetchDebtors = useCallback(async () => {
        try {
            setLoading(true);

            const response = await warehouseService.getDebtors({
                page: pagination.page,
                limit: pagination.limit,
                status: selectedStatus
            });

            setDebtors(response.data.debtors);
            setPagination(response.data.pagination);
            setAnalytics(response.data.analytics);
        } catch (error) {
            console.error('Failed to fetch debtors:', error);
        } finally {
            setLoading(false);
        }
    }, [pagination.page, pagination.limit, selectedStatus]);

    useEffect(() => {
        fetchDebtors();
    }, [selectedStatus, pagination.page, fetchDebtors]);

    const toggleExpanded = (receiptNumber: string) => {
        setExpandedReceipts(prev => {
            const newSet = new Set(prev);
            if (newSet.has(receiptNumber)) {
                newSet.delete(receiptNumber);
            } else {
                newSet.add(receiptNumber);
            }
            return newSet;
        });
    };

    const openPaymentModal = (receipt: DebtorReceipt) => {
        setSelectedReceipt(receipt);
        setPaymentAmount(receipt.amountDue.toString());
        setShowPaymentModal(true);
    };

    const closePaymentModal = () => {
        setShowPaymentModal(false);
        setSelectedReceipt(null);
        setPaymentAmount('');
        setPaymentReference('');
        setPaymentNotes('');
    };

    const handleRecordPayment = async () => {
        if (!selectedReceipt) return;

        // Validate payment amount
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

            const paymentData = {
                amount: amount,
                paymentMethod,
                paymentDate,
                referenceNumber: paymentReference || undefined,
                notes: paymentNotes || undefined
            };

            // ✅ NEW: Payment for entire receipt (all products)
            const response = await warehouseService.recordReceiptPayment(
                selectedReceipt.receiptNumber,
                paymentData
            );

            console.log('Payment response:', response);

            alert(
                `✅ Payment recorded successfully!\n\n` +
                `Receipt: ${selectedReceipt.receiptNumber}\n` +
                `Amount: ${formatCurrency(amount)}\n` +
                `Products Updated: ${response.data.debtsUpdated}\n` +
                `New Balance: ${formatCurrency(selectedReceipt.amountDue - amount)}`
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

    const formatCurrency = (amount: number) => {
        return `₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    };

    const formatDate = (dateString: string) => {
        return new Date(dateString).toLocaleDateString('en-NG', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    };

    const getStatusBadge = (status: string) => {
        const styles = {
            OUTSTANDING: 'bg-yellow-100 text-yellow-800',
            PARTIAL: 'bg-blue-100 text-blue-800',
            OVERDUE: 'bg-red-100 text-red-800',
            PAID: 'bg-green-100 text-green-800'
        };
        return (
            <span className={`px-2 py-1 rounded-full text-xs font-semibold ${styles[status as keyof typeof styles]}`}>
                {status}
            </span>
        );
    };

    const handleViewReceipt = (receiptNumber: string) => {
        // Navigate to receipt page
        window.location.href = `/warehouse/sales/receipt/${receiptNumber}`;
    };

    return (
        <div className="p-6 space-y-6">
            <h1 className="text-3xl font-bold text-gray-900">Warehouse Debtors</h1>

            {/* Analytics Cards */}
            {analytics && (
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    {Object.entries(analytics).map(([status, data]) => (
                        <div key={status} className="bg-white p-4 rounded-lg shadow border-l-4 border-blue-500">
                            <h3 className="text-sm font-semibold text-gray-600 mb-2">
                                {status.replace('_', ' ')}
                            </h3>
                            <p className="text-xl font-bold">{data.count}</p>
                            <p className="text-sm text-gray-500 mt-1">
                                Due: {formatCurrency(data.amountDue)}
                            </p>
                        </div>
                    ))}
                </div>
            )}

            {/* Filter */}
            <div className="mb-4">
                <label className="text-sm font-medium mr-2">Filter by Status:</label>
                <select
                    value={selectedStatus}
                    onChange={(e) => {
                        setSelectedStatus(e.target.value as any);
                        setPagination(prev => ({ ...prev, page: 1 }));
                    }}
                    className="px-4 py-2 border rounded-lg"
                >
                    <option value="all">All Status</option>
                    <option value="OUTSTANDING">Outstanding</option>
                    <option value="PARTIAL">Partially Paid</option>
                    <option value="OVERDUE">Overdue</option>
                    <option value="PAID">Paid</option>
                </select>
            </div>

            {/* Debtors List - Grouped by Receipt */}
            {loading ? (
                <div className="text-center py-12">
                    <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                    <p className="mt-2 text-gray-600">Loading debtors...</p>
                </div>
            ) : debtors.length === 0 ? (
                <div className="text-center py-12 bg-white rounded-lg shadow">
                    <p className="text-gray-500">No debtors found</p>
                </div>
            ) : (
                <>
                    <div className="grid gap-4">
                        {debtors.map((receipt) => {
                            const isExpanded = expandedReceipts.has(receipt.receiptNumber);

                            return (
                                <div key={receipt.receiptNumber} className="bg-white rounded-lg shadow hover:shadow-md transition-shadow">
                                    {/* Receipt Header */}
                                    <div className="p-6">
                                        <div className="flex justify-between items-start">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-3 mb-2">
                                                    <Receipt className="h-5 w-5 text-gray-500" />
                                                    <button
                                                        onClick={() => handleViewReceipt(receipt.receiptNumber)}
                                                        className="font-mono text-lg font-semibold text-blue-600 hover:text-blue-800 hover:underline"
                                                    >
                                                        {receipt.receiptNumber}
                                                    </button>
                                                    {getStatusBadge(receipt.status)}
                                                    <span className="text-xs bg-gray-100 px-2 py-1 rounded-full">
                                                        {receipt.productCount} {receipt.productCount === 1 ? 'product' : 'products'}
                                                    </span>
                                                    <button
                                                        onClick={() => toggleExpanded(receipt.receiptNumber)}
                                                        className="text-gray-500 hover:text-gray-700"
                                                    >
                                                        {isExpanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                                                    </button>
                                                </div>

                                                {/* Customer Info */}
                                                <div className="flex items-start gap-2 text-sm text-gray-600 mb-2">
                                                    <User className="h-4 w-4 mt-0.5" />
                                                    <div>
                                                        <p className="font-medium text-gray-900">{receipt.customer.name}</p>
                                                        <p>📞 {receipt.customer.phone}</p>
                                                        {receipt.customer.email && <p>✉️ {receipt.customer.email}</p>}
                                                    </div>
                                                </div>

                                                <p className="text-sm text-gray-500">
                                                    Sale Date: {formatDate(receipt.createdAt)}
                                                </p>
                                                {receipt.dueDate && (
                                                    <p className="text-sm text-gray-500">
                                                        Due Date: {formatDate(receipt.dueDate)}
                                                    </p>
                                                )}
                                            </div>

                                            <div className="text-right">
                                                <p className="text-sm text-gray-500">Total Amount</p>
                                                <p className="text-xl font-bold">{formatCurrency(receipt.totalAmount)}</p>

                                                <div className="mt-2 space-y-1">
                                                    <p className="text-sm text-green-600">Paid: {formatCurrency(receipt.amountPaid)}</p>
                                                    <p className="text-sm text-red-600 font-semibold">Due: {formatCurrency(receipt.amountDue)}</p>
                                                </div>

                                                {/* Payment Button */}
                                                {receipt.amountDue > 0 && (
                                                    <button
                                                        onClick={() => openPaymentModal(receipt)}
                                                        className="mt-3 inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition-colors"
                                                    >
                                                        <CreditCard className="h-4 w-4" />
                                                        Record Payment
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Expanded Products & Payment History */}
                                    {isExpanded && (
                                        <div className="border-t border-gray-200 p-6 bg-gray-50">
                                            {/* Products List */}
                                            <h4 className="font-semibold mb-3 flex items-center gap-2">
                                                <Package className="h-4 w-4" />
                                                Products ({receipt.productCount})
                                            </h4>
                                            <div className="space-y-3 mb-6">
                                                {receipt.products.map((product, idx) => (
                                                    <div key={product.debtorId} className="bg-white p-4 rounded border">
                                                        <div className="flex justify-between items-start">
                                                            <div>
                                                                <p className="font-medium text-gray-900">{product.product.name}</p>
                                                                <p className="text-xs text-gray-500">Product #: {product.product.productNo}</p>
                                                                <p className="text-sm text-gray-600 mt-1">
                                                                    {product.quantity} {product.unitType} @ {formatCurrency(product.unitPrice)}
                                                                </p>
                                                                <span className="text-xs mt-2 inline-block">{getStatusBadge(product.status)}</span>
                                                            </div>
                                                            <div className="text-right">
                                                                <p className="text-sm font-semibold">{formatCurrency(product.totalAmount)}</p>
                                                                <p className="text-xs text-green-600">Paid: {formatCurrency(product.amountPaid)}</p>
                                                                <p className="text-xs text-red-600">Due: {formatCurrency(product.amountDue)}</p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>

                                            {/* Payment History */}
                                            {receipt.allPayments.length > 0 && (
                                                <div>
                                                    <h4 className="font-semibold mb-3">
                                                        Payment History ({receipt.paymentCount} payment{receipt.paymentCount !== 1 ? 's' : ''})
                                                    </h4>
                                                    <div className="space-y-2">
                                                        {receipt.allPayments.map((payment) => (
                                                            <div key={payment.id} className="flex justify-between items-center text-sm bg-white p-3 rounded border">
                                                                <div>
                                                                    <span className="font-medium">{formatCurrency(payment.amount)}</span>
                                                                    <span className="text-gray-500 ml-2">via {payment.paymentMethod}</span>
                                                                    {payment.referenceNumber && (
                                                                        <span className="text-xs text-gray-400 ml-2 block">Ref: {payment.referenceNumber}</span>
                                                                    )}
                                                                    {payment.notes && (
                                                                        <span className="text-xs text-gray-500 block mt-1">{payment.notes}</span>
                                                                    )}
                                                                </div>
                                                                <span className="text-gray-500">{formatDate(payment.paymentDate)}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Pagination */}
                    <div className="flex justify-between items-center mt-6">
                        <button
                            disabled={pagination.page === 1}
                            onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
                            className="px-4 py-2 bg-gray-200 rounded disabled:opacity-50 hover:bg-gray-300 transition-colors"
                        >
                            Previous
                        </button>
                        <span className="text-gray-600">
                            Page {pagination.page} of {pagination.pages} ({pagination.total} receipts)
                        </span>
                        <button
                            disabled={pagination.page === pagination.pages}
                            onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
                            className="px-4 py-2 bg-gray-200 rounded disabled:opacity-50 hover:bg-gray-300 transition-colors"
                        >
                            Next
                        </button>
                    </div>
                </>
            )}

            {/* Payment Modal */}
            {showPaymentModal && selectedReceipt && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
                        <h2 className="text-xl font-bold mb-4">Record Payment</h2>

                        <div className="space-y-4">
                            <div className="bg-blue-50 p-4 rounded-lg">
                                <p className="text-sm font-medium text-gray-700">Receipt</p>
                                <p className="text-lg font-mono font-semibold">{selectedReceipt.receiptNumber}</p>

                                <div className="mt-3 border-t pt-3">
                                    <p className="text-sm font-medium text-gray-700">Products</p>
                                    <div className="mt-2 space-y-2">
                                        {selectedReceipt.products.map((product) => (
                                            <div key={product.debtorId} className="text-sm">
                                                <p className="font-medium">{product.product.name}</p>
                                                <p className="text-gray-600">{product.quantity} {product.unitType}</p>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="mt-3 border-t pt-3">
                                    <p className="text-sm font-medium text-gray-700">Customer</p>
                                    <p className="font-semibold">{selectedReceipt.customer.name}</p>
                                    <p className="text-sm text-gray-600">{selectedReceipt.customer.phone}</p>
                                </div>

                                <div className="mt-3 border-t pt-3">
                                    <p className="text-gray-600">Total: <span className="font-semibold">{formatCurrency(selectedReceipt.totalAmount)}</span></p>
                                    <p className="text-green-600">Paid: <span className="font-semibold">{formatCurrency(selectedReceipt.amountPaid)}</span></p>
                                    <p className="text-red-600">Outstanding: <span className="font-semibold">{formatCurrency(selectedReceipt.amountDue)}</span></p>
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium mb-1">Payment Amount *</label>
                                <input
                                    type="number"
                                    value={paymentAmount}
                                    onChange={(e) => setPaymentAmount(e.target.value)}
                                    className="w-full px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500"
                                    step="0.01"
                                    min="0"
                                    max={selectedReceipt.amountDue}
                                    placeholder="Enter amount"
                                />
                                <p className="text-xs text-gray-500 mt-1">
                                    Max: {formatCurrency(selectedReceipt.amountDue)}
                                </p>
                            </div>

                            <div>
                                <label className="block text-sm font-medium mb-1">Payment Method *</label>
                                <select
                                    value={paymentMethod}
                                    onChange={(e) => setPaymentMethod(e.target.value as any)}
                                    className="w-full px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500"
                                >
                                    <option value="CASH">Cash</option>
                                    <option value="BANK_TRANSFER">Bank Transfer</option>
                                    <option value="CHECK">Check</option>
                                    <option value="CARD">Card</option>
                                    <option value="MOBILE_MONEY">Mobile Money</option>
                                </select>
                            </div>

                            <div>
                                <label className="block text-sm font-medium mb-1">Payment Date *</label>
                                <input
                                    type="date"
                                    value={paymentDate}
                                    onChange={(e) => setPaymentDate(e.target.value)}
                                    className="w-full px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium mb-1">Reference Number</label>
                                <input
                                    type="text"
                                    value={paymentReference}
                                    onChange={(e) => setPaymentReference(e.target.value)}
                                    className="w-full px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500"
                                    placeholder="Optional"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium mb-1">Notes</label>
                                <textarea
                                    value={paymentNotes}
                                    onChange={(e) => setPaymentNotes(e.target.value)}
                                    className="w-full px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500"
                                    rows={3}
                                    placeholder="Optional payment notes"
                                />
                            </div>
                        </div>

                        <div className="flex gap-3 mt-6">
                            <button
                                onClick={handleRecordPayment}
                                disabled={processingPayment || !paymentAmount || parseFloat(paymentAmount) <= 0}
                                className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {processingPayment ? 'Processing...' : 'Record Payment'}
                            </button>
                            <button
                                onClick={closePaymentModal}
                                disabled={processingPayment}
                                className="flex-1 bg-gray-200 py-2 rounded hover:bg-gray-300 disabled:opacity-50"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DebtorsDashboard;
