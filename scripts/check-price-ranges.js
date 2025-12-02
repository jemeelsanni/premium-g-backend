#!/usr/bin/env node
/**
 * Check Product Price Ranges
 *
 * Verifies which products have min/max selling prices configured
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkPriceRanges() {
    try {
        const products = await prisma.product.findMany({
            select: {
                id: true,
                name: true,
                productNo: true,
                pricePerPack: true,
                minSellingPrice: true,
                maxSellingPrice: true,
                costPerPack: true
            },
            take: 20
        });

        console.log('📊 Product Price Ranges:\n');
        console.log('═'.repeat(100));

        let withRanges = 0;
        let withoutRanges = 0;
        const productsWithoutRanges = [];

        for (const product of products) {
            const hasRange = product.minSellingPrice !== null || product.maxSellingPrice !== null;
            if (hasRange) {
                withRanges++;
            } else {
                withoutRanges++;
                productsWithoutRanges.push(product);
            }

            const formatPrice = (val) => val !== null ? `₦${parseFloat(val).toLocaleString()}` : 'NOT SET';

            console.log(`Product: ${product.name} (${product.productNo})`);
            console.log(`  Cost: ${formatPrice(product.costPerPack)}`);
            console.log(`  Standard Price: ${formatPrice(product.pricePerPack)}`);
            console.log(`  Min Price: ${formatPrice(product.minSellingPrice)}`);
            console.log(`  Max Price: ${formatPrice(product.maxSellingPrice)}`);
            console.log(`  Status: ${hasRange ? '✅ Has Range' : '⚠️  No Range Set - ANY price allowed!'}`);
            console.log('─'.repeat(100));
        }

        console.log(`\n📈 Summary:`);
        console.log(`   Total products checked: ${products.length}`);
        console.log(`   Products with price ranges: ${withRanges}`);
        console.log(`   Products without ranges: ${withoutRanges}`);

        if (withoutRanges > 0) {
            console.log(`\n⚠️  WARNING: ${withoutRanges} product(s) don't have min/max prices set!`);
            console.log('   These products will accept ANY unit price during sale creation.\n');

            console.log('Products without price ranges:');
            productsWithoutRanges.forEach(p => {
                console.log(`   - ${p.name} (${p.productNo})`);
            });

            console.log('\n💡 To set price ranges, update these products via admin panel or API.');
        } else {
            console.log('\n✅ All products have price ranges configured!');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

checkPriceRanges();
