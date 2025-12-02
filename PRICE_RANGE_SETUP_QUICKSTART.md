# Price Range Setup - Quick Start Guide

## 🚀 Quick Setup (3 Steps)

### Step 1: Check Current Status
```bash
npm install  # Install dependencies if needed
node scripts/check-price-ranges.js
```

**Output will show:**
- ✅ Products with price ranges already set
- ⚠️ Products missing min/max prices

### Step 2: Preview Automatic Setup
```bash
# See what changes will be made (no changes yet)
node scripts/setup-price-ranges.js --preview
```

**This shows you:**
- Current prices for each product
- Proposed min/max prices
- Profit margins
- Which products will be updated

### Step 3: Apply the Setup
```bash
# Apply changes using balanced strategy (recommended)
node scripts/setup-price-ranges.js --apply
```

**Done! 🎉** Your products now have price ranges and validation is active!

---

## 📊 Pricing Strategies

Choose the strategy that fits your business:

### 1. **Balanced** (Recommended - Default)
```bash
node scripts/setup-price-ranges.js --strategy=balanced --apply
```
- **Min Price**: Cost + 15% profit
- **Max Price**: Standard price + 25%
- **Best for**: Most businesses - protects profit while allowing flexibility

### 2. **Tight Control**
```bash
node scripts/setup-price-ranges.js --strategy=tight --apply
```
- **Min Price**: Standard price - 10%
- **Max Price**: Standard price + 10%
- **Best for**: Strict pricing consistency, premium products

### 3. **Flexible**
```bash
node scripts/setup-price-ranges.js --strategy=flexible --apply
```
- **Min Price**: Cost + 10%
- **Max Price**: Standard price + 50%
- **Best for**: Different customer types (wholesale/retail), negotiable pricing

### 4. **Cost-Based**
```bash
node scripts/setup-price-ranges.js --strategy=costBased --apply
```
- **Min Price**: Cost + 20%
- **Max Price**: Cost + 100%
- **Best for**: Strict profit protection, always cover costs

---

## 📝 Example Walkthrough

### Scenario: You have products without price ranges

**Product: Coca-Cola 50cl**
- Cost: ₦80
- Standard Price: ₦120
- Min Price: NOT SET ⚠️
- Max Price: NOT SET ⚠️

**Step 1: Check Status**
```bash
$ node scripts/check-price-ranges.js

Product: Coca-Cola 50cl (COKE-001)
  Cost: ₦80
  Standard Price: ₦120
  Min Price: NOT SET
  Max Price: NOT SET
  Status: ⚠️ No Range Set - ANY price allowed!
```

**Step 2: Preview Setup**
```bash
$ node scripts/setup-price-ranges.js --preview

Product: Coca-Cola 50cl (COKE-001)
  Current:
    Cost: ₦80.00
    Standard Price: ₦120.00
    Min Price: NOT SET
    Max Price: NOT SET
  Proposed:
    Min Price: ₦92.00 ✨ NEW  (Cost + 15% = ₦80 × 1.15)
    Max Price: ₦150.00 ✨ NEW  (Std + 25% = ₦120 × 1.25)
  Profit Margins: 15.0% - 87.5%
```

**Step 3: Apply**
```bash
$ node scripts/setup-price-ranges.js --apply

✅ Updated: Coca-Cola 50cl

✨ Done!
   Successfully updated: 1
   Failed: 0

🎉 Price ranges have been set up!
```

**Step 4: Verify**
```bash
$ node scripts/check-price-ranges.js

Product: Coca-Cola 50cl (COKE-001)
  Cost: ₦80.00
  Standard Price: ₦120.00
  Min Price: ₦92.00
  Max Price: ₦150.00
  Status: ✅ Has Range
```

**Now test it:**
- ✅ Sell at ₦100 → Success
- ✅ Sell at ₦120 → Success
- ❌ Sell at ₦85 → Error: "Below minimum price (₦92)"
- ❌ Sell at ₦160 → Error: "Exceeds maximum price (₦150)"

---

## 🔧 Manual Setup (If You Prefer)

If you want to set specific ranges for individual products:

### Via API:
```bash
curl -X PUT http://localhost:3000/api/v1/products/{productId} \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "minSellingPrice": 92,
    "maxSellingPrice": 150
  }'
```

### Via Database:
```javascript
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

await prisma.product.update({
    where: { id: 'product-id-here' },
    data: {
        minSellingPrice: 92,
        maxSellingPrice: 150
    }
});
```

---

## ⚠️ Troubleshooting

### "Products skipped - Missing cost and standard price"
**Problem**: Some products don't have cost or standard price set
**Solution**:
1. Set `costPerPack` and/or `pricePerPack` on those products first
2. Re-run the setup script

### "Module not found: @prisma/client"
**Problem**: Dependencies not installed
**Solution**:
```bash
npm install
```

### "All products already have price ranges"
**Problem**: Ranges already set (or you already ran the script)
**Solution**: This is good! Run check script to verify:
```bash
node scripts/check-price-ranges.js
```

### "Need to change existing ranges"
**Problem**: Want to update ranges that are already set
**Solution**:
1. Manually update via API/database (script only sets new ones)
2. Or set existing ranges to `null` first, then re-run script

---

## 🧪 Testing

After setup, test the validation:

### Test 1: Below Minimum
```
1. Select product with min price ₦92
2. Enter unit price ₦85
3. Try to create sale
Expected: ❌ Error: "Unit price (₦85) is below minimum selling price (₦92)"
```

### Test 2: Above Maximum
```
1. Select product with max price ₦150
2. Enter unit price ₦160
3. Try to create sale
Expected: ❌ Error: "Unit price (₦160) exceeds maximum selling price (₦150)"
```

### Test 3: Within Range
```
1. Select product with range ₦92-₦150
2. Enter unit price ₦120
3. Create sale
Expected: ✅ Sale created successfully
```

---

## 📚 Full Documentation

For detailed information, see:
- **PRICE_RANGE_ENFORCEMENT_GUIDE.md** - Complete guide with all details
- **scripts/check-price-ranges.js** - Check product status
- **scripts/setup-price-ranges.js** - Automatic setup tool

---

## 💡 Pro Tips

1. **Start with preview**: Always use `--preview` first to see changes
2. **Choose right strategy**: Balanced works for most businesses
3. **Review and adjust**: After automatic setup, manually adjust specific products if needed
4. **Test thoroughly**: Create test sales with out-of-range prices
5. **Update regularly**: Review price ranges quarterly or when costs change

---

**Need help?** Check the full guide in `PRICE_RANGE_ENFORCEMENT_GUIDE.md`
