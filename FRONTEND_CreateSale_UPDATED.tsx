/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
// src/pages/warehouse/CreateSale.tsx
// ✅ UPDATED VERSION with Price Range Enforcement & Debt Calculation Fix
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Save, ArrowLeft, ShoppingCart, User, Package, Tag, Plus, Trash2, Edit2, AlertTriangle, CreditCard } from 'lucide-react';
import { warehouseService } from '../../services/warehouseService';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { globalToast } from '../../components/ui/Toast';

const productItemSchema = z.object({
    productId: z.string().min(1, 'Product is required'),
    quantity: z.number().min(1, 'Quantity must be at least 1'),
    unitType: z.enum(['PALLETS', 'PACKS', 'UNITS']),
    unitPrice: z.number().min(0.01, 'Unit price must be greater than 0'),
});

const saleSchema = z.object({
    warehouseCustomerId: z.string().min(1, 'Customer is required'),
    paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY', 'CREDIT']),
    paymentStatus: z.enum(['PAID', 'CREDIT', 'PARTIAL']).optional(),
    creditDueDate: z.string().optional(),
    creditNotes: z.string().optional(),
    amountPaid: z.number().optional(),
    initialPaymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']).optional(),
});

type ProductItemFormData = z.infer<typeof productItemSchema>;
type SaleFormData = z.infer<typeof saleSchema>;

interface CartItem extends ProductItemFormData {
    id: string;
    productName: string;
    productNo: string;
    originalUnitPrice: number;
    discountedUnitPrice: number;
    discountAmount: number;
    discountPercentage: number;
    subtotal: number;
    discountTotal: number;
    finalTotal: number;
    hasDiscount: boolean;
    discountInfo?: any;
}

interface DiscountInfo {
    hasDiscount: boolean;
    originalPrice: number;
    finalPrice: number;
    discountAmount: number;
    discountPercentage: number;
    totalSavings?: number;
    discount?: {
        id?: string;
        type?: string;
        value?: number;
        reason?: string;
        minimumQuantity?: number;
        maximumDiscountAmount?: number;
        validFrom?: string;
        validUntil?: string;
        approvalRequestId?: string;
    };
}

// ✅ NEW: Price validation state interface
interface PriceValidation {
    isValid: boolean;
    message: string;
    color: 'red' | 'green' | 'yellow';
}

export const CreateSale: React.FC = () => {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [cart, setCart] = useState<CartItem[]>([]);
    const [editingItemId, setEditingItemId] = useState<string | null>(null);
    const [isCheckingDiscount, setIsCheckingDiscount] = useState(false);
    const [currentDiscountInfo, setCurrentDiscountInfo] = useState<DiscountInfo | null>(null);
    const [showPartialPayment, setShowPartialPayment] = useState(false);

    // ✅ NEW: Price validation state
    const [priceValidation, setPriceValidation] = useState<PriceValidation | null>(null);

    // Product item form
    const {
        register: registerProduct,
        handleSubmit: handleSubmitProduct,
        watch: watchProduct,
        setValue: setValueProduct,
        reset: resetProduct,
        formState: { errors: productErrors }
    } = useForm<ProductItemFormData>({
        resolver: zodResolver(productItemSchema),
        defaultValues: {
            productId: '',
            quantity: 1,
            unitType: 'PACKS',
            unitPrice: 0,
        }
    });

    // Sale form
    const {
        register,
        handleSubmit,
        watch,
        setValue,
        formState: { errors, isSubmitting }
    } = useForm<SaleFormData>({
        resolver: zodResolver(saleSchema),
        defaultValues: {
            warehouseCustomerId: '',
            paymentMethod: 'CASH',
            creditDueDate: '',
            creditNotes: '',
            amountPaid: 0,
        }
    });

    // Fetch products
    const { data: products } = useQuery({
        queryKey: ['warehouse-products'],
        queryFn: () => warehouseService.getProducts(),
    });

    // Fetch customers
    const { data: customersData } = useQuery({
        queryKey: ['warehouse-customers'],
        queryFn: () => warehouseService.getCustomers({ page: 1, limit: 1000 }),
    });

    // Watch form fields
    const watchedCustomerId = watch('warehouseCustomerId');
    const watchedProductId = watchProduct('productId');
    const watchedQuantity = watchProduct('quantity');
    const watchedUnitPrice = watchProduct('unitPrice');
    const watchedPaymentMethod = watch('paymentMethod');

    // ✅ NEW: Real-time price validation
    useEffect(() => {
        const product = products?.find((p: any) => p.id === watchedProductId);
        const price = watchedUnitPrice;

        if (!product || !price || price <= 0) {
            setPriceValidation(null);
            return;
        }

        const hasRange = product.minSellingPrice || product.maxSellingPrice;

        if (!hasRange) {
            setPriceValidation({
                isValid: true,
                message: '⚠️ No price range set - any price allowed',
                color: 'yellow'
            });
            return;
        }

        // Check minimum
        if (product.minSellingPrice && price < product.minSellingPrice) {
            setPriceValidation({
                isValid: false,
                message: `Below minimum (₦${parseFloat(product.minSellingPrice).toLocaleString()})`,
                color: 'red'
            });
            return;
        }

        // Check maximum
        if (product.maxSellingPrice && price > product.maxSellingPrice) {
            setPriceValidation({
                isValid: false,
                message: `Above maximum (₦${parseFloat(product.maxSellingPrice).toLocaleString()})`,
                color: 'red'
            });
            return;
        }

        // Price is valid
        setPriceValidation({
            isValid: true,
            message: '✓ Price within allowed range',
            color: 'green'
        });
    }, [watchedProductId, watchedUnitPrice, products]);

    // Check for discount when product, quantity, or price changes
    useEffect(() => {
        const checkDiscount = async () => {
            if (watchedCustomerId && watchedProductId && watchedQuantity > 0 && watchedUnitPrice > 0) {
                setIsCheckingDiscount(true);
                try {
                    const discountInfo = await warehouseService.checkDiscount({
                        warehouseCustomerId: watchedCustomerId,
                        productId: watchedProductId,
                        quantity: watchedQuantity,
                        unitPrice: watchedUnitPrice,
                    });
                    setCurrentDiscountInfo(discountInfo.data);
                } catch (error) {
                    setCurrentDiscountInfo(null);
                } finally {
                    setIsCheckingDiscount(false);
                }
            } else {
                setCurrentDiscountInfo(null);
            }
        };

        checkDiscount();
    }, [watchedCustomerId, watchedProductId, watchedQuantity, watchedUnitPrice]);

    // ✅ UPDATED: Add product to cart with price range validation
    const handleAddProduct = (data: ProductItemFormData) => {
        const product = products?.find((p: any) => p.id === data.productId);
        if (!product) {
            globalToast.error('Product not found');
            return;
        }

        // ✅ NEW: Price range validation
        const price = data.unitPrice;

        if (product.minSellingPrice && price < product.minSellingPrice) {
            globalToast.error(
                `Price ₦${price.toLocaleString()} is below minimum (₦${parseFloat(product.minSellingPrice).toLocaleString()}) for ${product.name}`
            );
            return;
        }

        if (product.maxSellingPrice && price > product.maxSellingPrice) {
            globalToast.error(
                `Price ₦${price.toLocaleString()} exceeds maximum (₦${parseFloat(product.maxSellingPrice).toLocaleString()}) for ${product.name}`
            );
            return;
        }

        // 🚫 Out-of-stock check
        if (product.currentStock <= 0) {
            globalToast.error(`${product.name} is out of stock and cannot be added to cart.`);
            return;
        }

        // 🧠 Warn if quantity exceeds stock
        if (data.quantity > product.currentStock) {
            globalToast.error(
                `Only ${product.currentStock} units of ${product.name} available. Adjust quantity before adding.`
            );
            return;
        }

        // ✅ Proceed with normal add-to-cart logic
        const originalPrice = currentDiscountInfo?.originalPrice || data.unitPrice;
        const finalPrice = currentDiscountInfo?.finalPrice || data.unitPrice;
        const discountAmount = originalPrice - finalPrice;
        const discountPercentage = originalPrice > 0 ? (discountAmount / originalPrice) * 100 : 0;
        const subtotal = data.quantity * originalPrice;
        const discountTotal = data.quantity * discountAmount;
        const finalTotal = data.quantity * finalPrice;

        const cartItem: CartItem = {
            ...data,
            id: editingItemId || `item-${Date.now()}`,
            productName: product.name,
            productNo: product.productNo,
            originalUnitPrice: originalPrice,
            discountedUnitPrice: finalPrice,
            discountAmount,
            discountPercentage,
            subtotal,
            discountTotal,
            finalTotal,
            hasDiscount: currentDiscountInfo?.hasDiscount || false,
            discountInfo: currentDiscountInfo?.discount ? currentDiscountInfo.discount : undefined
        };

        if (editingItemId) {
            setCart(cart.map(item => item.id === editingItemId ? cartItem : item));
            setEditingItemId(null);
        } else {
            setCart([...cart, cartItem]);
        }

        resetProduct({
            productId: '',
            quantity: 1,
            unitType: 'PACKS',
            unitPrice: 0,
        });
        setCurrentDiscountInfo(null);
        setPriceValidation(null); // ✅ Reset validation
        globalToast.success(editingItemId ? 'Item updated!' : 'Item added to cart!');
    };

    // Edit cart item
    const handleEditItem = (item: CartItem) => {
        setEditingItemId(item.id);
        setValueProduct('productId', item.productId);
        setValueProduct('quantity', item.quantity);
        setValueProduct('unitType', item.unitType);
        setValueProduct('unitPrice', item.unitPrice);
    };

    // Remove item from cart
    const handleRemoveItem = (itemId: string) => {
        setCart(cart.filter(item => item.id !== itemId));
        globalToast.success('Item removed from cart');
    };

    // Cancel editing
    const handleCancelEdit = () => {
        setEditingItemId(null);
        resetProduct({
            productId: '',
            quantity: 1,
            unitType: 'PACKS',
            unitPrice: 0,
        });
        setCurrentDiscountInfo(null);
        setPriceValidation(null); // ✅ Reset validation
    };

    // Calculate cart totals
    const cartTotals = cart.reduce(
        (acc, item) => ({
            subtotal: acc.subtotal + item.subtotal,
            discount: acc.discount + item.discountTotal,
            total: acc.total + item.finalTotal
        }),
        { subtotal: 0, discount: 0, total: 0 }
    );

    // ✅ FIXED: Create sale mutation with correct debt calculation
    const createSaleMutation = useMutation({
        mutationFn: async (saleData: SaleFormData) => {
            const receiptNumber = await generateReceiptNumber();
            const cartTotal = cartTotals.total;

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
                // ✅ FIXED: Use finalTotal instead of recalculating
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
                    unitPrice: item.discountedUnitPrice,
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
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['warehouse-sales'] });
            queryClient.invalidateQueries({ queryKey: ['warehouse-inventory'] });
            queryClient.invalidateQueries({ queryKey: ['warehouse-customers'] });
            queryClient.invalidateQueries({ queryKey: ['warehouse-debtors'] });
            globalToast.success(`Sale recorded successfully with ${cart.length} item(s)!`);
            navigate('/warehouse/sales');
        },
        onError: (error: any) => {
            const message = error.response?.data?.message || 'Failed to record sale';

            // ✅ Highlight price range errors
            if (message.includes('below minimum selling price') ||
                message.includes('exceeds maximum selling price')) {
                globalToast.error(`Price Range Error: ${message}`);
            } else {
                globalToast.error(message);
            }
        }
    });

    const onSubmit = (data: SaleFormData) => {
        if (cart.length === 0) {
            globalToast.error('Please add at least one product to the cart');
            return;
        }

        // Validate credit sale fields
        if (data.paymentMethod === 'CREDIT') {
            if (!data.warehouseCustomerId) {
                globalToast.error('Please select a customer for credit sales');
                return;
            }

            if (!data.creditDueDate) {
                globalToast.error('Please specify a due date for credit sale');
                return;
            }

            // Validate partial payment
            if (showPartialPayment) {
                if (!data.amountPaid || data.amountPaid <= 0) {
                    globalToast.error('Please enter a valid partial payment amount');
                    return;
                }

                if (data.amountPaid > cartTotals.total) {
                    globalToast.error('Partial payment cannot exceed total amount');
                    return;
                }

                if (!data.initialPaymentMethod) {
                    globalToast.error('Please select a payment method for partial payment');
                    return;
                }
            }
        }

        createSaleMutation.mutate(data);
    };

    // Check if minimum quantity is met for current item
    const minimumQuantityMet = !currentDiscountInfo?.discount?.minimumQuantity ||
        watchedQuantity >= currentDiscountInfo.discount.minimumQuantity;
    const daysUntilExpiry = currentDiscountInfo?.discount?.validUntil
        ? Math.ceil((new Date(currentDiscountInfo.discount.validUntil).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
        : null;

    return (
        <div className="p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Record New Sale</h1>
                    <p className="text-sm text-gray-600 mt-1">
                        Select customer and add products to cart
                    </p>
                </div>
                <Button
                    variant="outline"
                    onClick={() => navigate('/warehouse/sales')}
                    className="flex items-center space-x-2"
                >
                    <ArrowLeft className="h-4 w-4" />
                    <span>Back to Sales</span>
                </Button>
            </div>

            {/* Customer Selection */}
            <div className="bg-white shadow rounded-lg p-6">
                <div className="flex items-center space-x-2 mb-4">
                    <User className="h-5 w-5 text-gray-600" />
                    <h3 className="text-lg font-medium text-gray-900">Customer Information</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Select Customer *
                        </label>
                        <select
                            {...register('warehouseCustomerId')}
                            className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                        >
                            <option value="">Choose customer</option>
                            {customersData?.data?.customers?.map((customer: any) => (
                                <option key={customer.id} value={customer.id}>
                                    {customer.name} {customer.phone ? `(${customer.phone})` : ''}
                                </option>
                            ))}
                        </select>
                        {errors.warehouseCustomerId && (
                            <p className="mt-1 text-sm text-red-600">{errors.warehouseCustomerId.message}</p>
                        )}
                    </div>
                </div>
            </div>

            {/* Add Product to Cart */}
            <div className="bg-white shadow rounded-lg">
                <div className="px-6 py-4 border-b border-gray-200">
                    <h3 className="text-lg font-medium text-gray-900 flex items-center">
                        <Package className="h-5 w-5 mr-2" />
                        {editingItemId ? 'Edit Product' : 'Add Product to Cart'}
                    </h3>
                </div>
                <div className="p-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                        {/* Product Selection */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Product *
                            </label>
                            <select
                                {...registerProduct('productId')}
                                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            >
                                <option value="">Select product</option>
                                {products?.map((product: any) => (
                                    <option
                                        key={product.id}
                                        value={product.id}
                                        disabled={product.currentStock <= 0}
                                    >
                                        {product.name} ({product.productNo})
                                        {product.currentStock <= 0 ? ' - Out of Stock' : ` (${product.currentStock} in stock)`}
                                    </option>
                                ))}
                            </select>
                            {productErrors.productId && (
                                <p className="mt-1 text-sm text-red-600">{productErrors.productId.message}</p>
                            )}
                        </div>

                        {/* Quantity */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Quantity *
                            </label>
                            <Input
                                type="number"
                                {...registerProduct('quantity', { valueAsNumber: true })}
                                min="1"
                            />
                            {productErrors.quantity && (
                                <p className="mt-1 text-sm text-red-600">{productErrors.quantity.message}</p>
                            )}
                        </div>

                        {/* Unit Type */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Unit Type *
                            </label>
                            <select
                                {...registerProduct('unitType')}
                                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            >
                                <option value="PACKS">Packs</option>
                                <option value="PALLETS">Pallets</option>
                                <option value="UNITS">Units</option>
                            </select>
                        </div>

                        {/* Unit Price */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Unit Price (₦) *
                            </label>
                            <Input
                                type="number"
                                step="0.01"
                                {...registerProduct('unitPrice', { valueAsNumber: true })}
                                min="0.01"
                                className={priceValidation && !priceValidation.isValid ? 'border-red-500' : ''}
                            />
                            {priceValidation && (
                                <p className={`mt-1 text-xs ${
                                    priceValidation.color === 'red' ? 'text-red-600' :
                                    priceValidation.color === 'green' ? 'text-green-600' :
                                    'text-yellow-600'
                                }`}>
                                    {priceValidation.message}
                                </p>
                            )}
                            {productErrors.unitPrice && (
                                <p className="mt-1 text-sm text-red-600">{productErrors.unitPrice.message}</p>
                            )}
                        </div>

                        {/* Add Button */}
                        <div className="flex items-end">
                            {editingItemId ? (
                                <div className="flex space-x-2 w-full">
                                    <Button
                                        type="button"
                                        onClick={handleSubmitProduct(handleAddProduct)}
                                        variant="primary"
                                        className="flex-1"
                                    >
                                        <Save className="h-4 w-4 mr-1" />
                                        Update
                                    </Button>
                                    <Button
                                        type="button"
                                        onClick={handleCancelEdit}
                                        variant="outline"
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            ) : (
                                <Button
                                    type="button"
                                    onClick={handleSubmitProduct(handleAddProduct)}
                                    variant="primary"
                                    className="w-full"
                                    disabled={priceValidation && !priceValidation.isValid}
                                >
                                    <Plus className="h-4 w-4 mr-1" />
                                    Add to Cart
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* ✅ NEW: Price Range Display */}
                    {watchedProductId && products && (() => {
                        const selectedProduct = products.find((p: any) => p.id === watchedProductId);
                        if (!selectedProduct) return null;

                        const hasRange = selectedProduct.minSellingPrice && selectedProduct.maxSellingPrice;

                        return (
                            <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
                                <div className="space-y-1 text-sm">
                                    {selectedProduct.pricePerPack && (
                                        <div className="flex justify-between">
                                            <span className="text-gray-600">Standard Price:</span>
                                            <span className="font-semibold text-gray-900">
                                                ₦{parseFloat(selectedProduct.pricePerPack).toLocaleString()}
                                            </span>
                                        </div>
                                    )}

                                    {hasRange ? (
                                        <div className="flex justify-between items-center">
                                            <span className="text-gray-600">Allowed Range:</span>
                                            <span className="font-semibold text-green-700">
                                                ₦{parseFloat(selectedProduct.minSellingPrice).toLocaleString()}
                                                {' - '}
                                                ₦{parseFloat(selectedProduct.maxSellingPrice).toLocaleString()}
                                            </span>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2 text-yellow-600">
                                            <AlertTriangle className="h-4 w-4" />
                                            <span>No price range set - any price allowed</span>
                                        </div>
                                    )}

                                    {selectedProduct.currentStock !== undefined && (
                                        <div className="flex justify-between text-gray-600">
                                            <span>In Stock:</span>
                                            <span>{selectedProduct.currentStock} units</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })()}

                    {/* Discount Info */}
                    {isCheckingDiscount && (
                        <div className="mt-4 p-4 bg-gray-50 rounded-md">
                            <p className="text-sm text-gray-600">Checking for discounts...</p>
                        </div>
                    )}

                    {currentDiscountInfo && currentDiscountInfo.hasDiscount && (
                        <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-md">
                            <div className="flex items-start">
                                <Tag className="h-5 w-5 text-green-600 mt-0.5 mr-2" />
                                <div className="flex-1">
                                    <h4 className="text-sm font-semibold text-green-900">
                                        Discount Available!
                                        {!minimumQuantityMet && (
                                            <span className="ml-2 text-yellow-700">(Minimum quantity not met)</span>
                                        )}
                                    </h4>
                                    <div className="mt-2 text-sm text-green-800 space-y-1">
                                        <p>
                                            <strong>Discount:</strong> {currentDiscountInfo.discountPercentage.toFixed(2)}%
                                            ({currentDiscountInfo.discount?.type})
                                        </p>
                                        <p>
                                            <strong>Original Price:</strong> ₦{currentDiscountInfo.originalPrice.toLocaleString()}
                                        </p>
                                        <p>
                                            <strong>Discounted Price:</strong> ₦{currentDiscountInfo.finalPrice.toLocaleString()}
                                        </p>
                                        {currentDiscountInfo.discount?.minimumQuantity && (
                                            <p>
                                                <strong>Minimum Quantity:</strong> {currentDiscountInfo.discount.minimumQuantity}
                                            </p>
                                        )}
                                        {daysUntilExpiry !== null && (
                                            <p className={daysUntilExpiry < 7 ? 'text-yellow-700' : ''}>
                                                <strong>Valid for:</strong> {daysUntilExpiry} more days
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Cart */}
            {cart.length > 0 && (
                <div className="bg-white shadow rounded-lg overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                        <h3 className="text-lg font-medium text-gray-900 flex items-center">
                            <ShoppingCart className="h-5 w-5 mr-2" />
                            Shopping Cart ({cart.length} {cart.length === 1 ? 'item' : 'items'})
                        </h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Product
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Quantity
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Unit Price
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Discount
                                    </th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Total
                                    </th>
                                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                        Actions
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {cart.map((item) => (
                                    <tr key={item.id}>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="text-sm font-medium text-gray-900">{item.productName}</div>
                                            <div className="text-sm text-gray-500">{item.productNo}</div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                            {item.quantity} {item.unitType.toLowerCase()}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                            {item.hasDiscount && (
                                                <div className="text-xs text-gray-500 line-through">
                                                    ₦{item.originalUnitPrice.toLocaleString()}
                                                </div>
                                            )}
                                            <div className={item.hasDiscount ? 'text-green-600 font-medium' : ''}>
                                                ₦{item.discountedUnitPrice.toLocaleString()}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                                            {item.hasDiscount ? (
                                                <div className="text-green-600 font-medium">
                                                    -{item.discountPercentage.toFixed(1)}%
                                                    <div className="text-xs">
                                                        -₦{item.discountTotal.toLocaleString()}
                                                    </div>
                                                </div>
                                            ) : (
                                                <span className="text-gray-500">-</span>
                                            )}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                            ₦{item.finalTotal.toLocaleString()}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                            <div className="flex items-center justify-end space-x-2">
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => handleEditItem(item)}
                                                >
                                                    <Edit2 className="h-4 w-4" />
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => handleRemoveItem(item.id)}
                                                    className="text-red-600 hover:text-red-700"
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot className="bg-gray-50">
                                <tr>
                                    <td colSpan={4} className="px-6 py-4 text-right text-sm font-medium text-gray-900">
                                        Subtotal:
                                    </td>
                                    <td colSpan={2} className="px-6 py-4 text-sm text-gray-900">
                                        ₦{cartTotals.subtotal.toLocaleString()}
                                    </td>
                                </tr>
                                {cartTotals.discount > 0 && (
                                    <tr>
                                        <td colSpan={4} className="px-6 py-4 text-right text-sm font-medium text-gray-900">
                                            Discount:
                                        </td>
                                        <td colSpan={2} className="px-6 py-4 text-sm text-green-700">
                                            -₦{cartTotals.discount.toLocaleString()}
                                        </td>
                                    </tr>
                                )}
                                <tr className="bg-gray-100">
                                    <td colSpan={4} className="px-6 py-4 text-right text-base font-bold text-gray-900">
                                        Total Amount:
                                    </td>
                                    <td colSpan={2} className="px-6 py-4 text-base font-bold text-gray-900">
                                        ₦{cartTotals.total.toLocaleString()}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            )}

            {/* Payment Information */}
            {cart.length > 0 && (
                <div className="bg-white shadow rounded-lg">
                    <div className="px-6 py-4 border-b border-gray-200">
                        <h3 className="text-lg font-medium text-gray-900">
                            Payment Information
                        </h3>
                    </div>
                    <div className="p-6 space-y-4">
                        {/* Payment Method */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Payment Method *
                            </label>
                            <select
                                {...register('paymentMethod')}
                                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            >
                                <option value="CASH">Cash</option>
                                <option value="BANK_TRANSFER">Bank Transfer</option>
                                <option value="CARD">Card</option>
                                <option value="MOBILE_MONEY">Mobile Money</option>
                                <option value="CREDIT">Credit (Pay Later)</option>
                            </select>
                            {errors.paymentMethod && (
                                <p className="mt-1 text-sm text-red-600">{errors.paymentMethod.message}</p>
                            )}
                        </div>

                        {/* Credit Sale Fields */}
                        {watchedPaymentMethod === 'CREDIT' && (
                            <>
                                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                                    <div className="flex items-start">
                                        <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5 mr-2" />
                                        <div className="flex-1">
                                            <h4 className="text-sm font-semibold text-yellow-900">Credit Sale</h4>
                                            <p className="text-sm text-yellow-800 mt-1">
                                                This sale will be recorded as credit. The customer will need to pay later.
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        Due Date *
                                    </label>
                                    <Input
                                        type="date"
                                        {...register('creditDueDate')}
                                        min={new Date().toISOString().split('T')[0]}
                                    />
                                    {errors.creditDueDate && (
                                        <p className="mt-1 text-sm text-red-600">{errors.creditDueDate.message}</p>
                                    )}
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        Credit Notes
                                    </label>
                                    <textarea
                                        {...register('creditNotes')}
                                        rows={3}
                                        className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                                        placeholder="Optional notes about this credit sale..."
                                    />
                                </div>

                                {/* Partial Payment Option */}
                                <div className="flex items-center space-x-2">
                                    <input
                                        type="checkbox"
                                        id="partialPayment"
                                        checked={showPartialPayment}
                                        onChange={(e) => {
                                            setShowPartialPayment(e.target.checked);
                                            if (!e.target.checked) {
                                                setValue('amountPaid', 0);
                                                setValue('initialPaymentMethod', undefined);
                                            }
                                        }}
                                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                                    />
                                    <label htmlFor="partialPayment" className="text-sm font-medium text-gray-700">
                                        Customer making partial payment now
                                    </label>
                                </div>

                                {/* Partial Payment Fields */}
                                {showPartialPayment && (
                                    <div className="ml-6 space-y-4 p-4 bg-blue-50 border border-blue-200 rounded-md">
                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                                Amount Paid Now (₦) *
                                            </label>
                                            <Input
                                                type="number"
                                                step="0.01"
                                                {...register('amountPaid', { valueAsNumber: true })}
                                                min="0.01"
                                                max={cartTotals.total}
                                                placeholder={`Max: ₦${cartTotals.total.toLocaleString()}`}
                                            />
                                            {errors.amountPaid && (
                                                <p className="mt-1 text-sm text-red-600">{errors.amountPaid.message}</p>
                                            )}
                                            <p className="mt-1 text-xs text-gray-600">
                                                Remaining balance: ₦{((cartTotals.total) - (watch('amountPaid') || 0)).toLocaleString()}
                                            </p>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                                Payment Method for Partial Payment *
                                            </label>
                                            <select
                                                {...register('initialPaymentMethod')}
                                                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                                            >
                                                <option value="">Select method</option>
                                                <option value="CASH">Cash</option>
                                                <option value="BANK_TRANSFER">Bank Transfer</option>
                                                <option value="CARD">Card</option>
                                                <option value="MOBILE_MONEY">Mobile Money</option>
                                            </select>
                                            {errors.initialPaymentMethod && (
                                                <p className="mt-1 text-sm text-red-600">{errors.initialPaymentMethod.message}</p>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </>
                        )}

                        {/* Submit Button */}
                        <div className="flex justify-end space-x-3 pt-4 border-t">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => navigate('/warehouse/sales')}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="button"
                                onClick={handleSubmit(onSubmit)}
                                disabled={createSaleMutation.isPending || isSubmitting}
                                className="flex items-center space-x-2"
                            >
                                {createSaleMutation.isPending ? (
                                    <>
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                                        <span>Recording Sale...</span>
                                    </>
                                ) : (
                                    <>
                                        <CreditCard className="h-4 w-4" />
                                        <span>Record Sale</span>
                                    </>
                                )}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

async function generateReceiptNumber() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const datePrefix = `${year}${month}${day}`;
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const receiptNumber = `${datePrefix}-${randomSuffix}`;
    return receiptNumber;
}
