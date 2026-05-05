const express = require('express');
const router = express.Router();
const supplierCompanyService = require('../services/supplierCompanyService');
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const { logDataChange, getClientIP } = require('../middleware/auditLogger');

/**
 * @route   GET /api/v1/supplier-companies
 * @desc    Get all supplier companies
 * @access  Private (All authenticated users)
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { isActive } = req.query;
    const companies = await supplierCompanyService.getAllSupplierCompanies({ isActive });

    res.json({
      success: true,
      data: companies
    });
  } catch (error) {
    console.error('Error fetching supplier companies:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch supplier companies',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/v1/supplier-companies/:id
 * @desc    Get supplier company by ID
 * @access  Private (All authenticated users)
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const company = await supplierCompanyService.getSupplierCompanyById(id);

    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    console.error('Error fetching supplier company:', error);
    const statusCode = error.message === 'Supplier company not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * @route   GET /api/v1/supplier-companies/:id/categories
 * @desc    Get product categories and SKUs for a supplier
 * @access  Private (All authenticated users)
 */
router.get('/:id/categories', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const categories = await supplierCompanyService.getSupplierCategories(id);

    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    console.error('Error fetching supplier categories:', error);
    const statusCode = error.message === 'Supplier company not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * @route   GET /api/v1/supplier-companies/:id/stats
 * @desc    Get supplier company statistics
 * @access  Private (All authenticated users)
 */
router.get('/:id/stats', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const stats = await supplierCompanyService.getSupplierCompanyStats(id);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching supplier company stats:', error);
    const statusCode = error.message === 'Supplier company not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * @route   POST /api/v1/supplier-companies
 * @desc    Create new supplier company
 * @access  Private (MANAGING_DIRECTOR, GENERAL_MANAGER, ACCOUNTANT only)
 */
router.post(
  '/',
  authenticateToken,
  authorizeRole(['MANAGING_DIRECTOR', 'GENERAL_MANAGER', 'ACCOUNTANT']),
  async (req, res) => {
    try {
      const { name, code, email, phone, address, contactPerson, notes, productCategories } = req.body;

      // Validation
      if (!name || !code) {
        return res.status(400).json({
          success: false,
          message: 'Name and code are required'
        });
      }

      const company = await supplierCompanyService.createSupplierCompany({
        name,
        code,
        email,
        phone,
        address,
        contactPerson,
        notes,
        productCategories: productCategories || []
      });

      logDataChange(req.user.id, 'SUPPLIER_COMPANY', company.id, 'CREATE', null, company, getClientIP(req)).catch(console.error);

      res.status(201).json({
        success: true,
        message: 'Supplier company created successfully',
        data: company
      });
    } catch (error) {
      console.error('Error creating supplier company:', error);
      const statusCode = error.message.includes('already exists') ? 400 : 500;
      res.status(statusCode).json({
        success: false,
        message: error.message
      });
    }
  }
);

/**
 * @route   PUT /api/v1/supplier-companies/:id
 * @desc    Update supplier company
 * @access  Private (MANAGING_DIRECTOR, GENERAL_MANAGER, ACCOUNTANT only)
 */
router.put(
  '/:id',
  authenticateToken,
  authorizeRole(['MANAGING_DIRECTOR', 'GENERAL_MANAGER', 'ACCOUNTANT']),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name, code, email, phone, address, contactPerson, notes, isActive, productCategories } = req.body;

      const oldCompany = await supplierCompanyService.getSupplierCompanyById(id).catch(() => null);

      const company = await supplierCompanyService.updateSupplierCompany(id, {
        name,
        code,
        email,
        phone,
        address,
        contactPerson,
        notes,
        isActive,
        productCategories
      });

      logDataChange(req.user.id, 'SUPPLIER_COMPANY', id, 'UPDATE', oldCompany, company, getClientIP(req)).catch(console.error);

      res.json({
        success: true,
        message: 'Supplier company updated successfully',
        data: company
      });
    } catch (error) {
      console.error('Error updating supplier company:', error);
      const statusCode = error.message === 'Supplier company not found' ? 404
        : error.message.includes('already exists') ? 400
        : 500;
      res.status(statusCode).json({
        success: false,
        message: error.message
      });
    }
  }
);

/**
 * @route   DELETE /api/v1/supplier-companies/:id
 * @desc    Delete supplier company
 * @access  Private (MANAGING_DIRECTOR only)
 */
router.delete(
  '/:id',
  authenticateToken,
  authorizeRole(['MANAGING_DIRECTOR']),
  async (req, res) => {
    try {
      const { id } = req.params;
      const oldCompany = await supplierCompanyService.getSupplierCompanyById(id).catch(() => null);
      const result = await supplierCompanyService.deleteSupplierCompany(id);

      logDataChange(req.user.id, 'SUPPLIER_COMPANY', id, 'DELETE', oldCompany, null, getClientIP(req)).catch(console.error);

      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      console.error('Error deleting supplier company:', error);
      const statusCode = error.message === 'Supplier company not found' ? 404 : 500;
      res.status(statusCode).json({
        success: false,
        message: error.message
      });
    }
  }
);

module.exports = router;
