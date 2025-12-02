# Price Range Enforcement Guide

## ✅ Current Status

**Good news!** Price range validation is **already implemented** in your backend.

When creating a sale, the system automatically validates that the unit price is within the product's configured min/max range.

## How It Works

### Backend Validation (Already Active)

**Location**: `/routes/warehouse.js` (lines 621-636)

```javascript
// Validates unit price is within allowed range
const price = parseFloat(unitPrice);

// Check minimum price
if (product.minSellingPrice !== null) {
    const minPrice = parseFloat(product.minSellingPrice);
    if (price < minPrice) {
        throw new ValidationError(
            `Unit price (₦${price}) is below minimum selling price (₦${minPrice}) for ${product.name}`
        );
    }
}

// Check maximum price
if (product.maxSellingPrice !== null) {
    const maxPrice = parseFloat(product.maxSellingPrice);
    if (price > maxPrice) {
        throw new ValidationError(
            `Unit price (₦${price}) exceeds maximum selling price (₦${maxPrice}) for ${product.name}`
        );
    }
}
```

**What happens when validation fails:**
- API returns `400 Bad Request`
- Error message clearly states the violation
- Sale is NOT created
- Frontend receives the error and should display it to the user

## Setup Required

### 1. Set Min/Max Prices on Products

For price range enforcement to work, products must have `minSellingPrice` and `maxSellingPrice` configured.

**Check your products:**

```bash
# Run this script to see which products have price ranges
node scripts/check-price-ranges.js
```

**Example output:**
```
Product: Coca-Cola 50cl (COKE-001)
  Cost: ₦80
  Standard Price: ₦120
  Min Price: ₦100        ← ✅ Set
  Max Price: ₦150        ← ✅ Set
  Status: ✅ Has Range

Product: Sprite 50cl (SPRT-001)
  Cost: ₦75
  Standard Price: ₦110
  Min Price: NOT SET     ← ⚠️ Missing!
  Max Price: NOT SET     ← ⚠️ Missing!
  Status: ⚠️ No Range Set - ANY price allowed!
```

### 2. Setting Price Ranges

**Option A: Via API (Recommended)**

```javascript
// Update product with price ranges
PUT /api/v1/products/:productId
{
    "minSellingPrice": 100,
    "maxSellingPrice": 150
}
```

**Option B: Via Database Script**

```javascript
// Set price ranges for all products (example: 20% below and above standard price)
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function setDefaultPriceRanges() {
    const products = await prisma.product.findMany({
        where: {
            OR: [
                { minSellingPrice: null },
                { maxSellingPrice: null }
            ]
        }
    });

    for (const product of products) {
        const standardPrice = parseFloat(product.pricePerPack || 0);

        if (standardPrice > 0) {
            await prisma.product.update({
                where: { id: product.id },
                data: {
                    minSellingPrice: standardPrice * 0.8,  // 20% below
                    maxSellingPrice: standardPrice * 1.2   // 20% above
                }
            });
            console.log(`✅ Set price range for ${product.name}`);
        }
    }
}

setDefaultPriceRanges();
```

**Option C: Via Admin Panel** (if you have one)
1. Go to Products management
2. Edit each product
3. Set "Minimum Selling Price" and "Maximum Selling Price" fields

## Frontend Integration

### Display Price Range to Users

To improve UX, show the allowed price range when users select a product:

**In `CreateSale.tsx`:**

```typescript
// When product is selected, show allowed range
const selectedProduct = products?.find(p => p.id === watchedProductId);

{selectedProduct && (
    <div className="mt-2 text-sm text-gray-600">
        {selectedProduct.minSellingPrice && selectedProduct.maxSellingPrice ? (
            <p className="flex items-center gap-2">
                <span className="font-medium">Allowed price range:</span>
                <span className="text-green-700">
                    ₦{parseFloat(selectedProduct.minSellingPrice).toLocaleString()}
                    {' - '}
                    ₦{parseFloat(selectedProduct.maxSellingPrice).toLocaleString()}
                </span>
            </p>
        ) : (
            <p className="text-yellow-600">
                ⚠️ No price range set - any price allowed
            </p>
        )}

        {selectedProduct.pricePerPack && (
            <p className="text-gray-500">
                Standard price: ₦{parseFloat(selectedProduct.pricePerPack).toLocaleString()}
            </p>
        )}
    </div>
)}
```

### Handle Validation Errors

Make sure your frontend displays price range errors:

```typescript
// In CreateSale mutation error handler
onError: (error: any) => {
    const message = error.response?.data?.message || 'Failed to record sale';

    // Price range errors will be in the message
    if (message.includes('below minimum selling price') ||
        message.includes('exceeds maximum selling price')) {
        globalToast.error(message);  // Shows exact price violation
    } else {
        globalToast.error(message);
    }
}
```

### Add Client-Side Validation (Optional)

For better UX, validate before submitting:

```typescript
const handleAddProduct = (data: ProductItemFormData) => {
    const product = products?.find(p => p.id === data.productId);

    if (product) {
        const price = data.unitPrice;

        // Check minimum
        if (product.minSellingPrice && price < product.minSellingPrice) {
            globalToast.error(
                `Price ₦${price} is below minimum (₦${product.minSellingPrice}) for ${product.name}`
            );
            return;
        }

        // Check maximum
        if (product.maxSellingPrice && price > product.maxSellingPrice) {
            globalToast.error(
                `Price ₦${price} exceeds maximum (₦${product.maxSellingPrice}) for ${product.name}`
            );
            return;
        }
    }

    // Continue with adding to cart...
};
```

## Testing

### Test Scenario 1: Below Minimum Price
```
1. Select product with min price ₦100
2. Enter unit price ₦80
3. Try to add to cart
Expected: Error message "Unit price (₦80) is below minimum selling price (₦100) for [Product]"
```

### Test Scenario 2: Above Maximum Price
```
1. Select product with max price ₦150
2. Enter unit price ₦200
3. Try to create sale
Expected: Error message "Unit price (₦200) exceeds maximum selling price (₦150) for [Product]"
```

### Test Scenario 3: Within Range
```
1. Select product with range ₦100-₦150
2. Enter unit price ₦120
3. Create sale
Expected: ✅ Sale created successfully
```

### Test Scenario 4: No Range Set
```
1. Select product with no min/max prices
2. Enter any unit price
Expected: ✅ Sale created (no validation)
```

## Recommended Price Range Strategy

### Conservative Approach (Tight Control)
```
minSellingPrice = standardPrice * 0.9  (10% discount max)
maxSellingPrice = standardPrice * 1.1  (10% markup max)
```

### Flexible Approach (More Freedom)
```
minSellingPrice = costPrice * 1.1     (At least 10% profit)
maxSellingPrice = standardPrice * 1.5  (Up to 50% markup)
```

### Wholesale vs Retail
```javascript
// Wholesale products (bulk)
minSellingPrice = costPrice * 1.05    (5% minimum profit)
maxSellingPrice = standardPrice * 1.2

// Retail products
minSellingPrice = costPrice * 1.2     (20% minimum profit)
maxSellingPrice = standardPrice * 1.5
```

## API Endpoints

### Get Product with Price Range
```
GET /api/v1/products/:productId

Response:
{
    "id": "...",
    "name": "Coca-Cola 50cl",
    "pricePerPack": 120,
    "minSellingPrice": 100,
    "maxSellingPrice": 150,
    "costPerPack": 80
}
```

### Update Product Price Range
```
PUT /api/v1/products/:productId
{
    "minSellingPrice": 100,
    "maxSellingPrice": 150
}
```

## Troubleshooting

### "Validation not working - any price is accepted"
**Cause**: Product doesn't have `minSellingPrice` or `maxSellingPrice` set
**Solution**: Run `check-price-ranges.js` to identify products, then set ranges

### "Error message not showing in frontend"
**Cause**: Frontend not handling validation errors properly
**Solution**: Check mutation error handler displays `error.response.data.message`

### "Price range too restrictive"
**Cause**: Min/max range is too narrow
**Solution**: Update product price ranges to allow more flexibility

### "Need different ranges for different customers"
**Cause**: Using same range for wholesale and retail
**Solution**: Implement customer-type-based pricing or discount system

## Benefits

✅ **Prevents Pricing Errors**: Sales officers can't accidentally enter wrong prices
✅ **Protects Profit Margins**: Ensures minimum profit on every sale
✅ **Controls Discounts**: Limits maximum discount without approval
✅ **Audit Trail**: All price violations are logged
✅ **Consistent Pricing**: Maintains pricing standards across team

## Advanced: Dynamic Price Ranges

If you need different price ranges for different scenarios:

```javascript
// Example: Different ranges for customer types
if (customer.customerType === 'WHOLESALER') {
    minPrice = product.wholesaleMinPrice;
    maxPrice = product.wholesaleMaxPrice;
} else {
    minPrice = product.retailMinPrice;
    maxPrice = product.retailMaxPrice;
}
```

This would require:
1. Adding new fields to Product model
2. Updating validation logic
3. Customer type selection in sale form

---

**Summary**: Price range enforcement is ACTIVE and working. Just ensure your products have `minSellingPrice` and `maxSellingPrice` configured!

**To get started:**
1. Run `node scripts/check-price-ranges.js` to see which products need ranges
2. Set min/max prices on all products
3. Test by trying to create a sale with out-of-range price
4. Optionally add frontend UI to display allowed ranges
