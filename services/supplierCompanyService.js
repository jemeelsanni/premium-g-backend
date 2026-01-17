const prisma = require('../config/database');

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
      }
    });

    return companies;
  }

  /**
   * Get supplier company by ID
   */
  async getSupplierCompanyById(id) {
    const company = await prisma.supplierCompany.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            distributionOrders: true
          }
        }
      }
    });

    if (!company) {
      throw new Error('Supplier company not found');
    }

    return company;
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
   * Create new supplier company
   */
  async createSupplierCompany(data) {
    const { name, code, email, phone, address, contactPerson, paymentTerms, notes } = data;

    // Check if name already exists
    const existingByName = await prisma.supplierCompany.findUnique({
      where: { name }
    });

    if (existingByName) {
      throw new Error('A supplier company with this name already exists');
    }

    // Check if code already exists
    const existingByCode = await prisma.supplierCompany.findUnique({
      where: { code }
    });

    if (existingByCode) {
      throw new Error('A supplier company with this code already exists');
    }

    const company = await prisma.supplierCompany.create({
      data: {
        name,
        code: code.toUpperCase(),
        email,
        phone,
        address,
        contactPerson,
        paymentTerms,
        notes
      }
    });

    return company;
  }

  /**
   * Update supplier company
   */
  async updateSupplierCompany(id, data) {
    const { name, code, email, phone, address, contactPerson, paymentTerms, notes, isActive } = data;

    // Check if company exists
    const existing = await prisma.supplierCompany.findUnique({
      where: { id }
    });

    if (!existing) {
      throw new Error('Supplier company not found');
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
        throw new Error('A supplier company with this name already exists');
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
        throw new Error('A supplier company with this code already exists');
      }
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (code !== undefined) updateData.code = code.toUpperCase();
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (address !== undefined) updateData.address = address;
    if (contactPerson !== undefined) updateData.contactPerson = contactPerson;
    if (paymentTerms !== undefined) updateData.paymentTerms = paymentTerms;
    if (notes !== undefined) updateData.notes = notes;
    if (isActive !== undefined) updateData.isActive = isActive;

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
      throw new Error('Supplier company not found');
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
      throw new Error('Supplier company not found');
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
