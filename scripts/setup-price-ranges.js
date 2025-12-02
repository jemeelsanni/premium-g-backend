#!/usr/bin/env node
/**
 * Setup Price Ranges for Products
 *
 * Automatically sets min/max selling prices for products that don't have them.
 * Offers multiple strategies based on cost price and standard price.
 *
 * Usage:
 *   node scripts/setup-price-ranges.js --preview          (See what will change)
 *   node scripts/setup-price-ranges.js --apply            (Apply changes)
 *   node scripts/setup-price-ranges.js --strategy=tight   (Use tight margins)
 *   node scripts/setup-price-ranges.js --strategy=flexible (Use flexible margins)
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ============================================
// PRICING STRATEGIES
// ============================================

const STRATEGIES = {
    // Conservative: Tight price control (±10% from standard price)
    tight: {
        name: 'Tight Control',
        description: 'Allows 10% discount and 10% markup from standard price',
        calculate: (product) => {
            const standardPrice = parseFloat(product.pricePerPack || 0);
            if (standardPrice === 0) return null;

            return {
                minSellingPrice: standardPrice * 0.9,   // 10% discount max
                maxSellingPrice: standardPrice * 1.1    // 10% markup max
            };
        }
    },

    // Balanced: Moderate flexibility (cost-based min, ±20% max)
    balanced: {
        name: 'Balanced',
        description: 'Min = cost + 15% profit, Max = standard price + 25%',
        calculate: (product) => {
            const costPrice = parseFloat(product.costPerPack || 0);
            const standardPrice = parseFloat(product.pricePerPack || 0);

            if (costPrice === 0 && standardPrice === 0) return null;

            let minPrice, maxPrice;

            // Minimum: Ensure at least 15% profit
            if (costPrice > 0) {
                minPrice = costPrice * 1.15;
            } else if (standardPrice > 0) {
                minPrice = standardPrice * 0.8;
            }

            // Maximum: Allow up to 25% above standard
            if (standardPrice > 0) {
                maxPrice = standardPrice * 1.25;
            } else if (costPrice > 0) {
                maxPrice = costPrice * 2.0;  // 100% markup if no standard price
            }

            if (!minPrice || !maxPrice) return null;

            return {
                minSellingPrice: minPrice,
                maxSellingPrice: maxPrice
            };
        }
    },

    // Flexible: Wide range for different scenarios
    flexible: {
        name: 'Flexible',
        description: 'Min = cost + 10%, Max = standard price + 50%',
        calculate: (product) => {
            const costPrice = parseFloat(product.costPerPack || 0);
            const standardPrice = parseFloat(product.pricePerPack || 0);

            if (costPrice === 0 && standardPrice === 0) return null;

            let minPrice, maxPrice;

            // Minimum: Just cover costs + 10%
            if (costPrice > 0) {
                minPrice = costPrice * 1.1;
            } else if (standardPrice > 0) {
                minPrice = standardPrice * 0.7;  // Allow 30% discount
            }

            // Maximum: Allow big markup for special cases
            if (standardPrice > 0) {
                maxPrice = standardPrice * 1.5;  // 50% markup
            } else if (costPrice > 0) {
                maxPrice = costPrice * 2.5;  // 150% markup
            }

            if (!minPrice || !maxPrice) return null;

            return {
                minSellingPrice: minPrice,
                maxSellingPrice: maxPrice
            };
        }
    },

    // Cost-based: Protect profit margins strictly
    costBased: {
        name: 'Cost-Based',
        description: 'Min = cost + 20%, Max = cost + 100% (ensures profit)',
        calculate: (product) => {
            const costPrice = parseFloat(product.costPerPack || 0);
            if (costPrice === 0) return null;

            return {
                minSellingPrice: costPrice * 1.2,   // 20% minimum profit
                maxSellingPrice: costPrice * 2.0    // 100% maximum markup
            };
        }
    }
};

// ============================================
// MAIN LOGIC
// ============================================

async function setupPriceRanges() {
    const args = process.argv.slice(2);
    const preview = args.includes('--preview');
    const apply = args.includes('--apply');
    const strategyArg = args.find(arg => arg.startsWith('--strategy='));
    const strategyName = strategyArg ? strategyArg.split('=')[1] : 'balanced';

    const strategy = STRATEGIES[strategyName];

    if (!strategy) {
        console.error(`❌ Invalid strategy: ${strategyName}`);
        console.log('\nAvailable strategies:');
        Object.keys(STRATEGIES).forEach(key => {
            const s = STRATEGIES[key];
            console.log(`  ${key.padEnd(12)} - ${s.description}`);
        });
        process.exit(1);
    }

    if (!preview && !apply) {
        console.log('❌ Please specify --preview or --apply');
        console.log('\nUsage:');
        console.log('  node scripts/setup-price-ranges.js --preview              (See changes)');
        console.log('  node scripts/setup-price-ranges.js --apply                (Apply changes)');
        console.log('  node scripts/setup-price-ranges.js --strategy=tight --apply');
        console.log('\nStrategies:', Object.keys(STRATEGIES).join(', '));
        process.exit(1);
    }

    console.log(`\n🎯 Using strategy: ${strategy.name}`);
    console.log(`   ${strategy.description}\n`);

    try {
        // Get products without price ranges
        const products = await prisma.product.findMany({
            where: {
                OR: [
                    { minSellingPrice: null },
                    { maxSellingPrice: null }
                ]
            },
            select: {
                id: true,
                name: true,
                productNo: true,
                costPerPack: true,
                pricePerPack: true,
                minSellingPrice: true,
                maxSellingPrice: true
            }
        });

        if (products.length === 0) {
            console.log('✅ All products already have price ranges configured!');
            process.exit(0);
        }

        console.log(`📦 Found ${products.length} product(s) without complete price ranges\n`);
        console.log('═'.repeat(120));

        const updates = [];
        let skipped = 0;

        for (const product of products) {
            const priceRange = strategy.calculate(product);

            if (!priceRange) {
                console.log(`⚠️  SKIPPED: ${product.name} (${product.productNo})`);
                console.log(`   Reason: Missing cost and standard price data`);
                console.log('─'.repeat(120));
                skipped++;
                continue;
            }

            const formatPrice = (val) => val ? `₦${parseFloat(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'NOT SET';

            console.log(`Product: ${product.name} (${product.productNo})`);
            console.log(`  Current:`);
            console.log(`    Cost: ${formatPrice(product.costPerPack)}`);
            console.log(`    Standard Price: ${formatPrice(product.pricePerPack)}`);
            console.log(`    Min Price: ${formatPrice(product.minSellingPrice)}`);
            console.log(`    Max Price: ${formatPrice(product.maxSellingPrice)}`);
            console.log(`  Proposed:`);
            console.log(`    Min Price: ${formatPrice(priceRange.minSellingPrice)} ${!product.minSellingPrice ? '✨ NEW' : '🔄 UPDATE'}`);
            console.log(`    Max Price: ${formatPrice(priceRange.maxSellingPrice)} ${!product.maxSellingPrice ? '✨ NEW' : '🔄 UPDATE'}`);

            // Calculate margins for info
            if (product.costPerPack) {
                const minProfit = ((priceRange.minSellingPrice - product.costPerPack) / product.costPerPack * 100).toFixed(1);
                const maxProfit = ((priceRange.maxSellingPrice - product.costPerPack) / product.costPerPack * 100).toFixed(1);
                console.log(`  Profit Margins: ${minProfit}% - ${maxProfit}%`);
            }

            console.log('─'.repeat(120));

            updates.push({
                id: product.id,
                name: product.name,
                ...priceRange
            });
        }

        console.log(`\n📊 Summary:`);
        console.log(`   Products to update: ${updates.length}`);
        console.log(`   Products skipped: ${skipped}`);

        if (apply) {
            console.log('\n🔧 Applying changes...\n');

            let success = 0;
            let failed = 0;

            for (const update of updates) {
                try {
                    await prisma.product.update({
                        where: { id: update.id },
                        data: {
                            minSellingPrice: update.minSellingPrice,
                            maxSellingPrice: update.maxSellingPrice
                        }
                    });
                    console.log(`✅ Updated: ${update.name}`);
                    success++;
                } catch (error) {
                    console.error(`❌ Failed: ${update.name} - ${error.message}`);
                    failed++;
                }
            }

            console.log(`\n✨ Done!`);
            console.log(`   Successfully updated: ${success}`);
            console.log(`   Failed: ${failed}`);

            if (success > 0) {
                console.log('\n🎉 Price ranges have been set up!');
                console.log('   Price validation is now active for these products.');
                console.log('\n💡 Next steps:');
                console.log('   1. Run: node scripts/check-price-ranges.js (verify all products)');
                console.log('   2. Test by creating a sale with out-of-range price');
            }
        } else {
            console.log('\n📋 PREVIEW MODE - No changes made');
            console.log('   To apply these changes, run:');
            console.log(`   node scripts/setup-price-ranges.js --strategy=${strategyName} --apply`);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

// Run the script
setupPriceRanges();
