#!/usr/bin/env node
/**
 * Debt Calculation Verification Script
 *
 * This script audits all debtor records to find inconsistencies
 * where amountPaid + amountDue ≠ totalAmount
 *
 * Usage:
 *   node scripts/verify-debt-calculations.js
 *   node scripts/verify-debt-calculations.js --fix  (to auto-correct)
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TOLERANCE = 0.01; // Allow 1 cent difference due to rounding

async function verifyDebtCalculations() {
    console.log('🔍 Starting debt calculation verification...\n');

    try {
        // Fetch all debtor records
        const debtors = await prisma.debtor.findMany({
            include: {
                sale: {
                    select: {
                        receiptNumber: true,
                        totalAmount: true,
                        unitPrice: true,
                        quantity: true
                    }
                },
                warehouseCustomer: {
                    select: {
                        name: true
                    }
                }
            },
            orderBy: {
                createdAt: 'desc'
            }
        });

        console.log(`📊 Total debtor records: ${debtors.length}\n`);

        const inconsistencies = [];
        let correctRecords = 0;

        for (const debtor of debtors) {
            const totalAmount = parseFloat(debtor.totalAmount);
            const amountPaid = parseFloat(debtor.amountPaid);
            const amountDue = parseFloat(debtor.amountDue);

            // Verify: totalAmount = amountPaid + amountDue
            const calculatedDue = totalAmount - amountPaid;
            const difference = Math.abs(amountDue - calculatedDue);

            if (difference > TOLERANCE) {
                inconsistencies.push({
                    debtorId: debtor.id,
                    receiptNumber: debtor.sale.receiptNumber,
                    customerName: debtor.warehouseCustomer.name,
                    totalAmount,
                    amountPaid,
                    recordedAmountDue: amountDue,
                    calculatedAmountDue: calculatedDue,
                    difference,
                    status: debtor.status,
                    createdAt: debtor.createdAt
                });
            } else {
                correctRecords++;
            }
        }

        // Display results
        console.log('✅ SUMMARY:');
        console.log(`   Correct records: ${correctRecords}`);
        console.log(`   Inconsistent records: ${inconsistencies.length}\n`);

        if (inconsistencies.length > 0) {
            console.log('❌ INCONSISTENCIES FOUND:\n');
            console.log('═'.repeat(120));

            for (const issue of inconsistencies) {
                console.log(`Receipt: ${issue.receiptNumber}`);
                console.log(`Customer: ${issue.customerName}`);
                console.log(`Debtor ID: ${issue.debtorId}`);
                console.log(`Total Amount: ₦${issue.totalAmount.toFixed(2)}`);
                console.log(`Amount Paid: ₦${issue.amountPaid.toFixed(2)}`);
                console.log(`Recorded Due: ₦${issue.recordedAmountDue.toFixed(2)} ❌`);
                console.log(`Calculated Due: ₦${issue.calculatedAmountDue.toFixed(2)} ✅`);
                console.log(`Difference: ₦${issue.difference.toFixed(2)}`);
                console.log(`Status: ${issue.status}`);
                console.log(`Created: ${issue.createdAt.toISOString()}`);
                console.log('─'.repeat(120));
            }

            // Check if --fix flag is provided
            const shouldFix = process.argv.includes('--fix');

            if (shouldFix) {
                console.log('\n🔧 FIXING INCONSISTENCIES...\n');
                await fixInconsistencies(inconsistencies);
            } else {
                console.log('\n💡 To automatically fix these inconsistencies, run:');
                console.log('   node scripts/verify-debt-calculations.js --fix\n');
            }

            // Export to CSV for review
            await exportToCSV(inconsistencies);
        } else {
            console.log('✨ All debt calculations are correct! No issues found.\n');
        }

    } catch (error) {
        console.error('❌ Error during verification:', error);
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

async function fixInconsistencies(inconsistencies) {
    let fixedCount = 0;
    let failedCount = 0;

    for (const issue of inconsistencies) {
        try {
            // Recalculate correct status
            const totalAmount = parseFloat(issue.totalAmount);
            const amountPaid = parseFloat(issue.amountPaid);
            const correctAmountDue = totalAmount - amountPaid;

            let correctStatus = 'OUTSTANDING';
            if (correctAmountDue <= 0) {
                correctStatus = 'PAID';
            } else if (amountPaid > 0) {
                correctStatus = 'PARTIAL';
            }

            // Update debtor record
            await prisma.debtor.update({
                where: { id: issue.debtorId },
                data: {
                    amountDue: correctAmountDue,
                    status: correctStatus
                }
            });

            console.log(`✅ Fixed ${issue.receiptNumber} - New due: ₦${correctAmountDue.toFixed(2)}, Status: ${correctStatus}`);
            fixedCount++;

        } catch (error) {
            console.error(`❌ Failed to fix ${issue.receiptNumber}:`, error.message);
            failedCount++;
        }
    }

    console.log(`\n📊 Fix Summary:`);
    console.log(`   Successfully fixed: ${fixedCount}`);
    console.log(`   Failed: ${failedCount}\n`);

    if (fixedCount > 0) {
        console.log('✨ Debt calculations have been corrected!\n');

        // Update customer outstanding debt totals
        console.log('🔄 Updating customer outstanding debt totals...');
        await updateCustomerTotals();
    }
}

async function updateCustomerTotals() {
    const customers = await prisma.warehouseCustomer.findMany({
        select: { id: true, name: true }
    });

    for (const customer of customers) {
        const totalOutstanding = await prisma.debtor.aggregate({
            where: {
                warehouseCustomerId: customer.id,
                status: { in: ['OUTSTANDING', 'PARTIAL', 'OVERDUE'] }
            },
            _sum: { amountDue: true }
        });

        await prisma.warehouseCustomer.update({
            where: { id: customer.id },
            data: {
                outstandingDebt: totalOutstanding._sum.amountDue || 0
            }
        });

        if (totalOutstanding._sum.amountDue > 0) {
            console.log(`   Updated ${customer.name}: ₦${totalOutstanding._sum.amountDue.toFixed(2)}`);
        }
    }

    console.log('✅ Customer totals updated\n');
}

async function exportToCSV(inconsistencies) {
    const fs = require('fs');
    const path = require('path');

    const csvHeader = 'Debtor ID,Receipt Number,Customer,Total Amount,Amount Paid,Recorded Due,Calculated Due,Difference,Status,Created At\n';

    const csvRows = inconsistencies.map(issue => {
        return [
            issue.debtorId,
            issue.receiptNumber,
            `"${issue.customerName}"`,
            issue.totalAmount.toFixed(2),
            issue.amountPaid.toFixed(2),
            issue.recordedAmountDue.toFixed(2),
            issue.calculatedAmountDue.toFixed(2),
            issue.difference.toFixed(2),
            issue.status,
            issue.createdAt.toISOString()
        ].join(',');
    }).join('\n');

    const csvContent = csvHeader + csvRows;
    const filename = `debt-inconsistencies-${new Date().toISOString().split('T')[0]}.csv`;
    const filepath = path.join(__dirname, '..', filename);

    fs.writeFileSync(filepath, csvContent);
    console.log(`\n📄 Inconsistencies exported to: ${filename}\n`);
}

// Run the verification
verifyDebtCalculations()
    .catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
