const { PrismaClient } = require('@prisma/client');
const { NotFoundError, ValidationError } = require('../middleware/errorHandler');
const prisma = new PrismaClient();

// Maps enum to human-readable category name
const CATEGORY_NAMES = {
  CSD: 'Carbonated Soda Drink',
  ED: 'Energy Drink',
  WATER: 'Water',
  JUICE: 'Juice'
};

class SupplierCompanyService {
  /**
   * Get all supplier companies
   */
  async getAllSupplierCompanies(filters = {}) {
    const { isActive } = filters;

    const where = {};

    if (isActive !== undefined) {
      where.isActive = isActive === 'true' || isActive === true;
    }

    const companies = await prisma.supplierCompany.findMany({
      where,
      orderBy: {
        name: 'asc'
      },
      include: {
        productCategories: {
          include: {
            skus: {
              orderBy: [{ skuValue: 'asc' }]
            }
          }
        }
      }
    });

    return companies;
  }

  /**
   * Get supplier company by ID (includes categories + SKUs)
   */
  async getSupplierCompanyById(id) {
    const company = await prisma.supplierCompany.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            distributionOrders: true
          }
        },
        productCategories: {
          include: {
            skus: {
              orderBy: [{ skuValue: 'asc' }]
            }
          },
          orderBy: { categoryType: 'asc' }
        }
      }
    });

    if (!company) {
      throw new NotFoundError('Supplier company not found');
    }

    return company;
  }

  /**
   * Get supplier categories with SKUs
   */
  async getSupplierCategories(supplierId) {
    const company = await prisma.supplierCompany.findUnique({
      where: { id: supplierId }
    });

    if (!company) {
      throw new NotFoundError('Supplier company not found');
    }

    const categories = await prisma.supplierCategory.findMany({
      where: { supplierCompanyId: supplierId },
      include: {
        skus: {
          orderBy: [{ skuValue: 'asc' }]
        }
      },
      orderBy: { categoryType: 'asc' }
    });

    return categories.map(cat => ({
      ...cat,
      categoryName: CATEGORY_NAMES[cat.categoryType] || cat.categoryType
    }));
  }

  /**
   * Get supplier company by code
   */
  async getSupplierCompanyByCode(code) {
    const company = await prisma.supplierCompany.findUnique({
      where: { code }
    });

    return company;
  }

  /**
   * Create new supplier company (with optional product categories + SKUs)
   */
  async createSupplierCompany(data) {
    const { name, code, email, phone, address, contactPerson, notes, productCategories = [] } = data;

    // Check if name already exists
    const existingByName = await prisma.supplierCompany.findUnique({
      where: { name }
    });

    if (existingByName) {
      throw new ValidationError('A supplier company with this name already exists');
    }

    // Check if code already exists
    const existingByCode = await prisma.supplierCompany.findUnique({
      where: { code }
    });

    if (existingByCode) {
      throw new ValidationError('A supplier company with this code already exists');
    }

    // Validate category types
    const validCategoryTypes = ['CSD', 'ED', 'WATER', 'JUICE'];
    for (const cat of productCategories) {
      if (!validCategoryTypes.includes(cat.categoryType)) {
        throw new ValidationError(`Invalid category type: ${cat.categoryType}. Must be one of: ${validCategoryTypes.join(', ')}`);
      }
    }

    // Create company with categories and SKUs in a transaction
    const company = await prisma.$transaction(async (tx) => {
      const created = await tx.supplierCompany.create({
        data: {
          name,
          code: code.toUpperCase(),
          email,
          phone,
          address,
          contactPerson,
          notes
        }
      });

      // Create categories with their SKUs
      for (const cat of productCategories) {
        await tx.supplierCategory.create({
          data: {
            supplierCompanyId: created.id,
            categoryType: cat.categoryType,
            skus: {
              create: (cat.skus || []).map(sku => ({
                skuValue: parseFloat(sku.skuValue),
                skuUnit: sku.skuUnit
              }))
            }
          },
          include: { skus: true }
        });
      }

      return tx.supplierCompany.findUnique({
        where: { id: created.id },
        include: {
          productCategories: {
            include: {
              skus: { orderBy: [{ skuValue: 'asc' }] }
            },
            orderBy: { categoryType: 'asc' }
          }
        }
      });
    });

    return company;
  }

  /**
   * Update supplier company (with optional category sync)
   */
  async updateSupplierCompany(id, data) {
    const { name, code, email, phone, address, contactPerson, notes, isActive, productCategories } = data;

    // Check if company exists
    const existing = await prisma.supplierCompany.findUnique({
      where: { id }
    });

    if (!existing) {
      throw new NotFoundError('Supplier company not found');
    }

    // Check if new name conflicts with another company
    if (name && name !== existing.name) {
      const nameConflict = await prisma.supplierCompany.findFirst({
        where: {
          name,
          id: { not: id }
        }
      });

      if (nameConflict) {
        throw new ValidationError('A supplier company with this name already exists');
      }
    }

    // Check if new code conflicts with another company
    if (code && code !== existing.code) {
      const codeConflict = await prisma.supplierCompany.findFirst({
        where: {
          code: code.toUpperCase(),
          id: { not: id }
        }
      });

      if (codeConflict) {
        throw new ValidationError('A supplier company with this code already exists');
      }
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (code !== undefined) updateData.code = code.toUpperCase();
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (address !== undefined) updateData.address = address;
    if (contactPerson !== undefined) updateData.contactPerson = contactPerson;
    if (notes !== undefined) updateData.notes = notes;
    if (isActive !== undefined) updateData.isActive = isActive;

    // If productCategories provided, sync them
    if (productCategories !== undefined) {
      const validCategoryTypes = ['CSD', 'ED', 'WATER', 'JUICE'];
      for (const cat of productCategories) {
        if (!validCategoryTypes.includes(cat.categoryType)) {
          throw new ValidationError(`Invalid category type: ${cat.categoryType}`);
        }
      }

      return prisma.$transaction(async (tx) => {
        await tx.supplierCompany.update({
          where: { id },
          data: updateData
        });

        // Sync categories: upsert each, then remove deleted ones
        const incomingTypes = productCategories.map(c => c.categoryType);

        // Delete categories not in the incoming list
        await tx.supplierCategory.deleteMany({
          where: {
            supplierCompanyId: id,
            categoryType: { notIn: incomingTypes }
          }
        });

        for (const cat of productCategories) {
          // Upsert the category
          const existingCat = await tx.supplierCategory.findUnique({
            where: {
              supplierCompanyId_categoryType: {
                supplierCompanyId: id,
                categoryType: cat.categoryType
              }
            },
            include: { skus: true }
          });

          if (existingCat) {
            // Sync SKUs: delete all and recreate
            await tx.supplierCategorySKU.deleteMany({
              where: { supplierCategoryId: existingCat.id }
            });

            for (const sku of (cat.skus || [])) {
              await tx.supplierCategorySKU.create({
                data: {
                  supplierCategoryId: existingCat.id,
                  skuValue: parseFloat(sku.skuValue),
                  skuUnit: sku.skuUnit
                }
              });
            }
          } else {
            await tx.supplierCategory.create({
              data: {
                supplierCompanyId: id,
                categoryType: cat.categoryType,
                skus: {
                  create: (cat.skus || []).map(sku => ({
                    skuValue: parseFloat(sku.skuValue),
                    skuUnit: sku.skuUnit
                  }))
                }
              }
            });
          }
        }

        return tx.supplierCompany.findUnique({
          where: { id },
          include: {
            productCategories: {
              include: {
                skus: { orderBy: [{ skuValue: 'asc' }] }
              },
              orderBy: { categoryType: 'asc' }
            }
          }
        });
      });
    }

    const company = await prisma.supplierCompany.update({
      where: { id },
      data: updateData
    });

    return company;
  }

  /**
   * Delete supplier company (soft delete by setting isActive to false)
   */
  async deleteSupplierCompany(id) {
    // Check if company exists
    const existing = await prisma.supplierCompany.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            distributionOrders: true
          }
        }
      }
    });

    if (!existing) {
      throw new NotFoundError('Supplier company not found');
    }

    // Check if company has orders
    if (existing._count.distributionOrders > 0) {
      // Soft delete - just deactivate
      const company = await prisma.supplierCompany.update({
        where: { id },
        data: { isActive: false }
      });

      return {
        message: 'Supplier company deactivated successfully (has existing orders)',
        company
      };
    }

    // Hard delete if no orders
    await prisma.supplierCompany.delete({
      where: { id }
    });

    return {
      message: 'Supplier company deleted successfully'
    };
  }

  /**
   * Get supplier company statistics
   */
  async getSupplierCompanyStats(id) {
    const company = await prisma.supplierCompany.findUnique({
      where: { id },
      include: {
        distributionOrders: {
          select: {
            id: true,
            finalAmount: true,
            amountPaidToSupplier: true,
            supplierStatus: true,
            paidToSupplier: true,
            createdAt: true
          }
        }
      }
    });

    if (!company) {
      throw new NotFoundError('Supplier company not found');
    }

    const stats = {
      totalOrders: company.distributionOrders.length,
      totalValue: company.distributionOrders.reduce((sum, order) => sum + Number(order.finalAmount), 0),
      totalPaid: company.distributionOrders.reduce((sum, order) => sum + Number(order.amountPaidToSupplier || 0), 0),
      pendingPayments: company.distributionOrders.filter(o => !o.paidToSupplier).length,
      ordersByStatus: {
        NOT_SENT: company.distributionOrders.filter(o => o.supplierStatus === 'NOT_SENT').length,
        PAYMENT_SENT: company.distributionOrders.filter(o => o.supplierStatus === 'PAYMENT_SENT').length,
        ORDER_RAISED: company.distributionOrders.filter(o => o.supplierStatus === 'ORDER_RAISED').length,
        PROCESSING: company.distributionOrders.filter(o => o.supplierStatus === 'PROCESSING').length,
        LOADED: company.distributionOrders.filter(o => o.supplierStatus === 'LOADED').length,
        DISPATCHED: company.distributionOrders.filter(o => o.supplierStatus === 'DISPATCHED').length
      }
    };

    return {
      company: {
        id: company.id,
        name: company.name,
        code: company.code,
        email: company.email,
        phone: company.phone,
        isActive: company.isActive
      },
      stats
    };
  }
}

module.exports = new SupplierCompanyService();
