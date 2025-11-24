/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseApiService, apiClient } from './api';
import {
  WarehouseSale,
  WarehouseSaleRecord,
  WarehouseInventory,
  WarehouseCustomer,
  Product,
  WarehouseExpense
} from '../types/warehouse';
import { PaginatedResponse } from '../types/common';

export type WarehouseUnitType = 'PALLETS' | 'PACKS' | 'UNITS';
export type WarehousePaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD' | 'MOBILE_MONEY';

// 🆕 NEW: Enhanced profitability types
export interface WarehouseDashboardSummary {
  // Revenue & Costs
  totalRevenue: number;
  totalCOGS: number;
  totalExpenses: number;

  // Profitability
  grossProfit: number;
  netProfit: number;
  grossProfitMargin: number;
  netProfitMargin: number;

  // Cost Ratios
  cogsRatio: number;
  expenseRatio: number;

  // Sales Metrics
  totalSales: number;
  totalQuantitySold: number;
  averageSaleValue: number;

  // Efficiency Metrics
  revenuePerCustomer: number;
  profitPerSale: number;

  // Customer Metrics
  totalCustomers: number;
  activeCustomers: number;
}

// 🆕 NEW: Expense breakdown interface
export interface ExpenseBreakdown {
  total: number;
  byCategory: {
    [category: string]: number;
  };
}

// 🆕 NEW: Top product with profitability
export interface TopProfitableProduct {
  productName: string;
  sales: number;
  revenue: number;
  cogs: number;
  quantity: number;
  grossProfit: number;
  allocatedExpenses: number;
  netProfit: number;
  netProfitMargin: number;
}

// 🆕 NEW: Top customer with profitability
export interface TopProfitableCustomer {
  customerId: string;
  customerName: string;
  orderCount: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  allocatedExpenses: number;
  netProfit: number;
  netProfitMargin: number;
  outstandingDebt: number;
}

// 🆕 ENHANCED: Dashboard stats response
export interface WarehouseDashboardStatsResponse {
  success: boolean;
  data: {
    summary: WarehouseDashboardSummary;
    cashFlow: {
      totalCashIn: number;
      totalCashOut: number;
      netCashFlow: number;
    };
    inventory: {
      totalStockValue: number;
      totalItems: number;
      lowStockItems: number;
      outOfStockItems: number;
      stockHealthPercentage: number;
    };
    expenseBreakdown: ExpenseBreakdown;
    debtorSummary: {
      totalDebtors: number;
      totalOutstanding: number;
      totalCreditSales: number;
      totalPaid: number;
    };
    customerSummary: {
      totalCustomers: number;
      activeCustomers: number;
    };
    topProducts: TopProfitableProduct[];
    topCustomers: TopProfitableCustomer[];
    dailyPerformance: Array<{
      date: string;
      sales: number;
      revenue: number;
    }>;
    period: {
      startDate?: string;
      endDate?: string;
      filterMonth?: number;
      filterYear?: number;
    };
  };
}

export interface CreateSaleData {
  productId: string;
  quantity: number;
  unitType: WarehouseUnitType;
  unitPrice: number;
  paymentMethod: WarehousePaymentMethod;
  customerName: string;
  customerPhone?: string;
  warehouseCustomerId?: string;
  applyDiscount?: boolean;
  requestDiscountApproval?: boolean;
  discountReason?: string;
  requestedDiscountPercent?: number;
  receiptNumber?: string;
}

export interface CustomerFilters {
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'recent' | 'topSpender' | 'topPurchases' | 'creditScore';
  customerType?: 'INDIVIDUAL' | 'BUSINESS' | 'RETAILER';
  hasOutstandingDebt?: boolean;
  search?: string;
  startDate?: string;
  endDate?: string;
  filterMonth?: number;
  filterYear?: number;
}

export interface CustomerPurchaseFilters {
  page?: number;
  limit?: number;
  startDate?: string;
  endDate?: string;
}

export interface CustomerPurchaseHistory {
  id: string;
  receiptNumber: string;
  productId: string;
  quantity: number;
  unitType: string;
  unitPrice: number;
  totalAmount: number;
  totalDiscountAmount: number | null;
  discountApplied: boolean;
  discountPercentage: number | null;
  paymentMethod: string;
  createdAt: string;
  product: {
    name: string;
    productNo: string;
  };
}

export interface CustomerInsights {
  topProducts: Array<{
    name: string;
    productNo: string;
    purchase_count: number;
    totalQuantity: number;
    totalSpent: number;
    avg_price: number;
  }>;
  spendingTrend: Array<{
    month: string;
    purchaseCount: number;
    totalSpent: number;
  }>;
  debtSummary: {
    activeDebts: number;
    totalOutstanding: number;
  };
}

export interface CustomerDetailResponse {
  success: boolean;
  data: {
    customer: WarehouseCustomer;
    insights: CustomerInsights;
  };
}

export interface CustomerPurchaseHistoryResponse {
  success: boolean;
  data: {
    purchases: CustomerPurchaseHistory[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      pages: number;
    };
    summary: {
      totalPurchases: number;
      totalSpent: number;
      averageOrderValue: number;
    };
    customer: {
      id: string;
      name: string;
      phone: string | null;
      customerType: string;
    };
  };
}

export interface DebtorSummary {
  totalDebtors: number;
  totalOutstanding: number;
  totalCreditSales: number;
  totalPaid: number;
}

export interface OpeningStockItem {
  productId: string;
  productNo: string;
  productName: string;
  location: string | null;
  date: string;
  openingStock: {
    pallets: number;
    packs: number;
    units: number;
    total: number;
  };
  movements: {
    salesQuantity: number;
    salesRevenue: number;
    purchasesQuantity: number;
    salesCount: number;
    purchasesCount: number;
  };
  closingStock: {
    pallets: number;
    packs: number;
    units: number;
    total: number;
  };
  variance: {
    pallets: number;
    packs: number;
    units: number;
    total: number;
  };
  reorderLevel: number;
  stockStatus: 'LOW_STOCK' | 'NORMAL';
}

export interface OpeningStockSummary {
  date: string;
  totalProducts: number;
  totalOpeningStock: number;
  totalClosingStock: number;
  totalSalesRevenue: number;
  totalSalesQuantity: number;
  totalPurchasesQuantity: number;
  lowStockItems: number;
}

export interface OpeningStockResponse {
  success: boolean;
  data: {
    summary: OpeningStockSummary;
    openingStock: OpeningStockItem[];
  };
}

export interface OpeningStockFilters {
  date?: string;
  productId?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
}

export interface OpeningStockHistoryItem {
  date: string;
  openingStock: {
    pallets: number;
    packs: number;
    units: number;
    total: number;
  };
}

export interface OpeningStockHistoryResponse {
  success: boolean;
  data: {
    product: {
      id: string;
      name: string;
      productNo: string;
    };
    history: OpeningStockHistoryItem[];
  };
}

export interface OpeningStockHistoryFilters {
  startDate: string;
  endDate: string;
  productId?: string;
}

export interface ExpiringBatch {
  id: string;
  productName: string;
  productNo: string;
  batchNumber: string;
  orderNumber: string;
  expiryDate: string;
  originalQuantity: number;
  quantityRemaining: number;
  quantitySold: number;
  unitType: string;
  valueAtRisk: number;
  potentialRevenue: number;
  daysUntilExpiry: number;
  urgency: 'critical' | 'high' | 'medium';
  percentageSold: number;
}

export interface ExpiringProductsSummary {
  totalBatchesExpiring: number;
  criticalBatches: number;
  highPriorityBatches: number;
  totalValueAtRisk: number;
  totalPotentialRevenue: number;
}

export interface ExpiringProductsResponse {
  expiringPurchases: ExpiringBatch[];
  count: number;
  summary: ExpiringProductsSummary;
}

export interface CreateCashFlowData {
  transactionType: 'CASH_IN' | 'CASH_OUT';
  amount: number;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'POS' | 'CHECK' | 'MOBILE_MONEY';
  description?: string;
  referenceNumber?: string;
}

export interface CreateSaleResponse {
  success: boolean;
  message: string;
  pendingApproval?: boolean;
  data: {
    sale: WarehouseSaleRecord;
  };
}

export interface WarehouseSalesResponse {
  success: boolean;
  data: {
    sales: WarehouseSale[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  };
}

export interface WarehouseExpenseFilters {
  page?: number;
  limit?: number;
  status?: string;
  expenseType?: string;
  category?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  isPaid?: boolean;
}

export interface CreateWarehouseExpenseData {
  expenseType: string;
  category: string;
  amount: number;
  description?: string;
  expenseDate?: string;
  productId?: string;
}

export interface CreateDiscountRequestData {
  warehouseCustomerId: string;
  productId: string;
  requestedDiscountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'BULK_DISCOUNT';
  requestedDiscountValue: number;
  minimumQuantity?: number;
  maximumDiscountAmount?: number;
  validFrom: string;
  validUntil?: string;
  reason: string;
  businessJustification?: string;
  estimatedImpact?: number;
}

export interface CreateCustomerData {
  name: string;
  phone: string;
  address: string;
  customerType: string;
}

export interface CheckDiscountData {
  warehouseCustomerId: string;
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface RequestDiscountData {
  warehouseCustomerId: string;
  productId?: string;
  requestedDiscountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  requestedDiscountValue: number;
  reason: string;
  validFrom: string;
  validUntil?: string;
  minimumQuantity?: number;
  maximumDiscountAmount?: number;
  businessJustification?: string;
}

export interface UpdateInventoryData {
  currentStock?: number;
  minimumStock?: number;
  maximumStock?: number;
  pallets?: number;
  packs?: number;
  units?: number;
  reorderLevel?: number;
  maxStockLevel?: number;
}

export interface DebtorAnalytics {
  [key: string]: {
    count: number;
    totalAmount: number;
    amountPaid: number;
    amountDue: number;
  };
}

export interface Debtor {
  id: string;
  warehouseCustomerId: string;
  saleId: string;
  totalAmount: number;
  amountPaid: number;
  amountDue: number;
  dueDate: string | null;
  status: 'OUTSTANDING' | 'PARTIAL' | 'OVERDUE' | 'PAID';
  createdAt: string;
  customer: {
    name: string;
    phone: string;
    email?: string;
  };
  sale: {
    receiptNumber: string;
    createdAt: string;
    productId: string;
    quantity: number;
    unitType: string;
  };
  payments?: Array<{
    id: string;
    amount: number;
    paymentMethod: string;
    paymentDate: string;
  }>;
}

export interface DebtorPayment {
  id: string;
  debtorId: string;
  amount: number;
  paymentMethod: WarehousePaymentMethod;
  paymentDate: string;
  referenceNumber?: string;
  notes?: string;
  receivedBy: string;
}

export interface DebtorFilters {
  page?: number;
  limit?: number;
  status?: 'OUTSTANDING' | 'PARTIAL' | 'OVERDUE' | 'PAID' | 'all';
}

export interface WarehousePurchase {
  id: string;
  productId: string;
  vendorName: string;
  vendorPhone?: string;
  vendorEmail?: string;
  orderNumber?: string;
  batchNumber?: string;
  expiryDate?: string;
  quantity: number;
  unitType: WarehouseUnitType;
  costPerUnit: number;
  totalCost: number;
  paymentMethod: WarehousePaymentMethod;
  paymentStatus: 'PAID' | 'PARTIAL' | 'PENDING';
  amountPaid: number;
  amountDue: number;
  purchaseDate: string;
  invoiceNumber?: string;
  receiptUrl?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  product: {
    name: string;
    productNo: string;
  };
  createdByUser: {
    username: string;
    role?: string;
  };
}

export interface CreatePurchaseData {
  productId: string;
  vendorName: string;
  vendorPhone?: string;
  vendorEmail?: string;
  orderNumber?: string;
  batchNumber?: string;
  expiryDate?: string;
  quantity: number;
  unitType: WarehouseUnitType;
  costPerUnit: number;
  paymentMethod: WarehousePaymentMethod;
  paymentStatus?: 'PAID' | 'PARTIAL' | 'PENDING';
  amountPaid?: number;
  purchaseDate: string;
  invoiceNumber?: string;
  notes?: string;
}

export interface PurchaseFilters {
  page?: number;
  limit?: number;
  productId?: string;
  vendorName?: string;
  paymentStatus?: 'PAID' | 'PARTIAL' | 'PENDING';
  startDate?: string;
  endDate?: string;
}

export interface ExpiringPurchase extends WarehousePurchase {
  daysUntilExpiry: number;
  urgency: 'critical' | 'high' | 'medium';
}

export interface RecordPaymentData {
  amount: number;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD' | 'MOBILE_MONEY';
  paymentDate: string;
  referenceNumber?: string;
  notes?: string;
}

export class WarehouseService extends BaseApiService {
  constructor() {
    super('/warehouse');
  }

  // Sales
  async getSales(
    page = 1,
    limit = 10,
    filters?: {
      customerId?: string;
      productId?: string;
      startDate?: string;
      endDate?: string;
    }
  ): Promise<WarehouseSalesResponse> {
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
    });

    if (filters) {
      if (filters.customerId) params.append('customerId', filters.customerId);
      if (filters.productId) params.append('productId', filters.productId);
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
    }

    const query = params.toString();

    try {
      return await this.get<WarehouseSalesResponse>(`/sales?${query}`);
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return {
          success: true,
          data: {
            sales: [],
            pagination: {
              page,
              limit,
              total: 0,
              totalPages: 0,
            },
          },
        };
      }
      throw error;
    }
  }

  async createSale(data: CreateSaleData): Promise<CreateSaleResponse> {
    return this.post<CreateSaleResponse>(data, '/sales');
  }

  async getProducts(): Promise<Product[]> {
    const response = await this.get<{ success: boolean; data: { products: Product[] } }>('/products');
    return response.data.products;
  }

  async getSaleByReceipt(receiptNumber: string): Promise<{
    success: boolean;
    data: WarehouseSale;
  }> {
    return this.get(`/sales/receipt/${receiptNumber}`);
  }

  // Inventory
  async getInventory(page = 1, limit = 10): Promise<PaginatedResponse<WarehouseInventory>> {
    return this.get<PaginatedResponse<WarehouseInventory>>(`/inventory?page=${page}&limit=${limit}`);
  }

  async getInventoryItem(id: string): Promise<WarehouseInventory> {
    return this.get<WarehouseInventory>(`/inventory/${id}`);
  }

  async updateInventory(id: string, data: UpdateInventoryData): Promise<WarehouseInventory> {
    const payload: Record<string, number> = {};

    if (typeof data.pallets === 'number') payload.pallets = data.pallets;
    if (typeof data.packs === 'number') payload.packs = data.packs;
    if (typeof data.units === 'number') payload.units = data.units;
    if (typeof data.reorderLevel === 'number') payload.reorderLevel = data.reorderLevel;
    if (typeof data.maxStockLevel === 'number') payload.maxStockLevel = data.maxStockLevel;

    if (typeof data.currentStock === 'number') payload.packs = data.currentStock;
    if (typeof data.minimumStock === 'number') payload.reorderLevel = data.minimumStock;
    if (typeof data.maximumStock === 'number') payload.maxStockLevel = data.maximumStock;

    return this.put<WarehouseInventory>(payload, `/inventory/${id}`);
  }

  // Expenses
  async getExpenses(filters?: WarehouseExpenseFilters): Promise<{
    success: boolean;
    data: {
      expenses: WarehouseExpense[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    };
  }> {
    const params = new URLSearchParams();

    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          params.append(key, value.toString());
        }
      });
    }

    const query = params.toString();
    const suffix = query.length > 0 ? `?${query}` : '';

    try {
      return await this.get(`/expenses${suffix}`);
    } catch (error: any) {
      console.error('Failed to fetch warehouse expenses', error);

      return {
        success: true,
        data: {
          expenses: [],
          pagination: {
            page: Number(filters?.page) || 1,
            limit: Number(filters?.limit) || 10,
            total: 0,
            totalPages: 1
          }
        }
      };
    }
  }

  async createExpense(data: CreateWarehouseExpenseData): Promise<WarehouseExpense> {
    const payload = {
      expenseType: data.expenseType,
      category: data.category,
      amount: data.amount,
      description: data.description,
      expenseDate: data.expenseDate || new Date().toISOString(),
      productId: data.productId || undefined
    };

    const response = await this.post<{ success: boolean; data: { expense: WarehouseExpense } }>(
      payload,
      '/expenses'
    );

    return response.data.expense;
  }

  async updateExpenseStatus(
    id: string,
    status: WarehouseExpense['status'],
    options?: { rejectionReason?: string }
  ): Promise<WarehouseExpense> {
    const payload: Record<string, unknown> = { status };

    if (status === 'REJECTED' && options?.rejectionReason) {
      payload.rejectionReason = options.rejectionReason;
    }

    const response = await this.put<{ success: boolean; data: { expense: WarehouseExpense } }>(
      payload,
      `/expenses/${id}`
    );

    return response.data.expense;
  }

  // Expiring Products
  async getExpiringProducts(): Promise<ExpiringProductsResponse> {
    const response = await apiClient.get('/warehouse/purchases/expiring');
    return response.data.data;
  }

  // Customers
  async getCustomers(filters: CustomerFilters | number, limit?: number, search?: string): Promise<PaginatedResponse<WarehouseCustomer>> {
    if (typeof filters === 'number') {
      const page = filters;
      let url = `/customers?page=${page}&limit=${limit || 10}`;
      if (search?.trim()) {
        url += `&search=${encodeURIComponent(search.trim())}`;
      }
      return this.get<PaginatedResponse<WarehouseCustomer>>(url);
    }

    const params = new URLSearchParams();
    params.append('page', (filters.page || 1).toString());
    params.append('limit', (filters.limit || 10).toString());
    if (filters.search) params.append('search', filters.search);
    if (filters.customerType) params.append('customerType', filters.customerType);
    if (filters.hasOutstandingDebt !== undefined) params.append('hasOutstandingDebt', filters.hasOutstandingDebt.toString());
    if (filters.sortBy) params.append('sortBy', filters.sortBy);

    return this.get<PaginatedResponse<WarehouseCustomer>>(`/customers?${params.toString()}`);
  }

  async getCustomer(id: string): Promise<WarehouseCustomer> {
    return this.get<WarehouseCustomer>(`/customers/${id}`);
  }

  async createCustomer(data: CreateCustomerData): Promise<WarehouseCustomer> {
    return this.post<WarehouseCustomer>(data, '/customers');
  }

  async updateCustomer(id: string, data: Partial<CreateCustomerData>): Promise<WarehouseCustomer> {
    return this.put<WarehouseCustomer>(data, `/customers/${id}`);
  }

  async getCustomerById(id: string): Promise<CustomerDetailResponse> {
    return this.get<CustomerDetailResponse>(`/customers/${id}`);
  }

  async getCustomerPurchaseHistory(
    id: string,
    filters?: CustomerPurchaseFilters
  ): Promise<CustomerPurchaseHistoryResponse> {
    const params = new URLSearchParams();
    if (filters?.page) params.append('page', filters.page.toString());
    if (filters?.limit) params.append('limit', filters.limit.toString());
    if (filters?.startDate) params.append('startDate', filters.startDate);
    if (filters?.endDate) params.append('endDate', filters.endDate);

    const queryString = params.toString();
    const url = `/customers/${id}/purchases${queryString ? `?${queryString}` : ''}`;

    return this.get<CustomerPurchaseHistoryResponse>(url);
  }

  // Cash Flow
  async getCashFlow(
    page = 1,
    limit = 20,
    transactionType?: string,
    paymentMethod?: string,
    startDate?: string,
    endDate?: string,
    isReconciled?: boolean
  ): Promise<any> {
    const params = new URLSearchParams();
    params.append('page', page.toString());
    params.append('limit', limit.toString());

    if (transactionType) params.append('transactionType', transactionType);
    if (paymentMethod) params.append('paymentMethod', paymentMethod);
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    if (isReconciled !== undefined) params.append('isReconciled', isReconciled.toString());

    return this.get(`/cash-flow?${params.toString()}`);
  }

  async createCashFlow(data: CreateCashFlowData): Promise<any> {
    const response = await this.post<{
      success: boolean;
      message: string;
      data: { cashFlow: any }
    }>(data, '/cash-flow');
    return response;
  }

  // Opening Stock
  async getOpeningStock(filters?: OpeningStockFilters): Promise<OpeningStockResponse> {
    const params = new URLSearchParams();

    if (filters?.date) params.append('date', filters.date);
    if (filters?.productId) params.append('productId', filters.productId);
    if (filters?.location) params.append('location', filters.location);
    if (filters?.startDate) params.append('startDate', filters.startDate);
    if (filters?.endDate) params.append('endDate', filters.endDate);

    const queryString = params.toString();
    const endpoint = queryString ? `/opening-stock?${queryString}` : '/opening-stock';

    return this.get<OpeningStockResponse>(endpoint);
  }

  async getOpeningStockHistory(
    filters: OpeningStockHistoryFilters
  ): Promise<OpeningStockHistoryResponse> {
    const params = new URLSearchParams({
      startDate: filters.startDate,
      endDate: filters.endDate,
    });

    if (filters.productId) {
      params.append('productId', filters.productId);
    }

    return this.get<OpeningStockHistoryResponse>(`/opening-stock/history?${params.toString()}`);
  }

  // Discount Requests
  async checkDiscount(data: {
    warehouseCustomerId: string;
    productId: string;
    quantity: number;
    unitPrice: number;
  }): Promise<any> {
    return this.post(data, '/discounts/check');
  }

  async requestDiscount(data: {
    warehouseCustomerId: string;
    productId?: string;
    requestedDiscountType: string;
    requestedDiscountValue: number;
    reason: string;
    validFrom: string;
    validUntil?: string;
    minimumQuantity?: number;
    maximumDiscountAmount?: number;
    businessJustification?: string;
  }): Promise<any> {
    return this.post(data, '/discounts/request');
  }

  async getDiscountRequests(page = 1, limit = 20, status = 'PENDING'): Promise<any> {
    return this.get(`/discounts/requests?page=${page}&limit=${limit}&status=${status}`);
  }

  async reviewDiscountRequest(id: string, action: 'approve' | 'reject', data: {
    adminNotes?: string;
    rejectionReason?: string;
  }): Promise<any> {
    return this.put({ action, ...data }, `/discounts/requests/${id}/review`);
  }

  async getCustomerDiscounts(customerId: string): Promise<any> {
    return this.get(`/customers/${customerId}/discounts`);
  }

  async approveDiscount(id: string, adminNotes?: string): Promise<any> {
    return this.put({ action: 'approve', adminNotes }, `/discounts/requests/${id}/review`);
  }

  async rejectDiscount(id: string, rejectionReason?: string, adminNotes?: string): Promise<any> {
    return this.put({ action: 'reject', rejectionReason, adminNotes }, `/discounts/requests/${id}/review`);
  }

  async createDiscountRequest(data: CreateDiscountRequestData): Promise<any> {
    return this.post(data, '/discounts/request');
  }

  // 🆕 ENHANCED: Analytics with profitability
  async getDashboardStats(params?: {
    filterMonth?: number;
    filterYear?: number;
    startDate?: string;
    endDate?: string;
  }): Promise<WarehouseDashboardStatsResponse> {
    try {
      const queryParams = new URLSearchParams();

      if (params?.filterMonth) {
        queryParams.append('filterMonth', params.filterMonth.toString());
      }
      if (params?.filterYear) {
        queryParams.append('filterYear', params.filterYear.toString());
      }
      if (params?.startDate) {
        queryParams.append('startDate', params.startDate);
      }
      if (params?.endDate) {
        queryParams.append('endDate', params.endDate);
      }

      const queryString = queryParams.toString();
      const url = `/warehouse/analytics/summary${queryString ? `?${queryString}` : ''}`;

      const response = await apiClient.get(url);
      return response.data;
    } catch (error: any) {
      if (error?.response?.status === 400 || error?.response?.status === 404) {
        // Return empty state matching the new structure
        return {
          success: true,
          data: {
            summary: {
              totalRevenue: 0,
              totalCOGS: 0,
              totalExpenses: 0,
              grossProfit: 0,
              netProfit: 0,
              grossProfitMargin: 0,
              netProfitMargin: 0,
              cogsRatio: 0,
              expenseRatio: 0,
              totalSales: 0,
              totalQuantitySold: 0,
              averageSaleValue: 0,
              revenuePerCustomer: 0,
              profitPerSale: 0,
              totalCustomers: 0,
              activeCustomers: 0
            },
            cashFlow: {
              totalCashIn: 0,
              totalCashOut: 0,
              netCashFlow: 0
            },
            inventory: {
              totalStockValue: 0,
              totalItems: 0,
              lowStockItems: 0,
              outOfStockItems: 0,
              stockHealthPercentage: 0
            },
            expenseBreakdown: {
              total: 0,
              byCategory: {}
            },
            debtorSummary: {
              totalDebtors: 0,
              totalOutstanding: 0,
              totalCreditSales: 0,
              totalPaid: 0
            },
            customerSummary: {
              totalCustomers: 0,
              activeCustomers: 0
            },
            topProducts: [],
            topCustomers: [],
            dailyPerformance: [],
            period: {}
          }
        };
      }
      throw error;
    }
  }

  async getCustomerDetails(customerId: string): Promise<any> {
    return this.get(`/customers/${customerId}`);
  }

  async getCustomerPurchases(customerId: string, filters?: { page?: number; limit?: number; startDate?: string; endDate?: string }): Promise<any> {
    const params = new URLSearchParams();
    if (filters) Object.entries(filters).forEach(([k, v]) => v && params.append(k, String(v)));
    const query = params.toString();
    return this.get(query ? `/customers/${customerId}/purchases?${query}` : `/customers/${customerId}/purchases`);
  }

  // Debtors
  async getDebtors(filters?: DebtorFilters): Promise<any> {
    const params = new URLSearchParams();
    if (filters) Object.entries(filters).forEach(([k, v]) => v && params.append(k, String(v)));
    const query = params.toString();
    return this.get(query ? `/debtors?${query}` : '/debtors');
  }

  async recordDebtorPayment(debtorId: string, data: RecordPaymentData): Promise<any> {
    return this.post(data, `/debtors/${debtorId}/payments`);
  }

  async recordReceiptPayment(receiptNumber: string, data: RecordPaymentData): Promise<any> {
    const paymentData: any = {
      amount: parseFloat(data.amount.toString()),
      paymentMethod: data.paymentMethod,
      paymentDate: data.paymentDate
    };

    if (data.referenceNumber && data.referenceNumber.trim()) {
      paymentData.referenceNumber = data.referenceNumber.trim();
    }

    if (data.notes && data.notes.trim()) {
      paymentData.notes = data.notes.trim();
    }

    return this.post(paymentData, `/debtors/receipt/${receiptNumber}/payment`);
  }

  async recordCustomerDebtPayment(customerId: string, data: RecordPaymentData): Promise<any> {
    return this.post(data, `/debtors/customer/${customerId}/payment`);
  }

  async getCustomerDebtSummary(customerId: string): Promise<any> {
    return this.get(`/debtors/customer/${customerId}/summary`);
  }

  // Export Methods
  async exportSaleToPDF(saleId: string): Promise<Blob> {
    const response = await apiClient.get(`/warehouse/sales/${saleId}/export/pdf`, {
      responseType: 'blob'
    });
    return response.data;
  }

  async exportCashFlowToCSV(filters?: {
    startDate?: string;
    endDate?: string;
    transactionType?: string;
    paymentMethod?: string;
  }): Promise<Blob> {
    const params = new URLSearchParams();
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.append(key, value);
      });
    }

    const response = await apiClient.get(`/warehouse/cash-flow/export/csv?${params.toString()}`, {
      responseType: 'blob'
    });
    return response.data;
  }

  async exportCashFlowToPDF(filters?: {
    startDate?: string;
    endDate?: string;
    transactionType?: string;
    paymentMethod?: string;
  }): Promise<Blob> {
    const params = new URLSearchParams();
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.append(key, value);
      });
    }

    const response = await apiClient.get(`/warehouse/cash-flow/export/pdf?${params.toString()}`, {
      responseType: 'blob'
    });
    return response.data;
  }

  async exportSalesToCSV(filters?: {
    period?: 'day' | 'week' | 'month' | 'year' | 'custom';
    startDate?: string;
    endDate?: string;
    customerId?: string;
    productId?: string;
  }): Promise<Blob> {
    const params = new URLSearchParams();
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.append(key, value);
      });
    }

    const response = await apiClient.get(`/warehouse/sales/export/csv?${params}`, {
      responseType: 'blob'
    });
    return response.data;
  }

  async exportSalesToPDF(filters?: {
    period?: 'day' | 'week' | 'month' | 'year' | 'custom';
    startDate?: string;
    endDate?: string;
    customerId?: string;
    productId?: string;
    limit?: number;
  }): Promise<Blob> {
    const params = new URLSearchParams();
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      });
    }

    const response = await apiClient.get(`/warehouse/sales/export/pdf?${params}`, {
      responseType: 'blob'
    });
    return response.data;
  }

  // Warehouse Purchases
  async getPurchases(filters?: PurchaseFilters): Promise<PaginatedResponse<WarehousePurchase>> {
    const params = new URLSearchParams();
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      });
    }
    const query = params.toString();
    return this.get<PaginatedResponse<WarehousePurchase>>(
      query ? `/purchases?${query}` : '/purchases'
    );
  }

  async createPurchase(data: CreatePurchaseData): Promise<{
    success: boolean;
    message: string;
    warning?: {
      message: string;
      daysRemaining: number;
      expiryDate: string;
    };
    data: WarehousePurchase;
  }> {
    return this.post<any>(data, '/purchases');
  }

  async getPurchaseById(id: string): Promise<{ success: boolean; data: { purchase: WarehousePurchase } }> {
    return this.get(`/purchases/${id}`);
  }

  async getExpiringPurchases(): Promise<{
    success: boolean;
    data: {
      expiringPurchases: ExpiringPurchase[];
      count: number;
    };
  }> {
    return this.get('/purchases/expiring');
  }

  async getPurchaseAnalytics(filters?: {
    startDate?: string;
    endDate?: string;
  }): Promise<{
    success: boolean;
    data: {
      summary: {
        totalPurchases: number;
        totalCost: number;
        totalPaid: number;
        totalDue: number;
      };
      topProducts: Array<{
        product: {
          id: string;
          name: string;
          productNo: string;
        };
        totalQuantity: number;
        totalCost: number;
        purchaseCount: number;
      }>;
      topVendors: Array<{
        vendorName: string;
        totalSpent: number;
        purchaseCount: number;
      }>;
      paymentBreakdown: any[];
    };
  }> {
    const params = new URLSearchParams();
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.append(key, value);
      });
    }
    const query = params.toString();
    return this.get(query ? `/purchases/analytics?${query}` : '/purchases/analytics');
  }
}

export const warehouseService = new WarehouseService();
