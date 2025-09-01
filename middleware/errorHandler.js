const { Prisma } = require('@prisma/client');

// ================================
// GLOBAL ERROR HANDLER
// ================================

const errorHandler = (error, req, res, next) => {
  console.error('Error occurred:', {
    message: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    url: req.url,
    method: req.method,
    user: req.user?.id || 'unauthenticated',
    timestamp: new Date().toISOString()
  });

  // Handle Prisma errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return handlePrismaError(error, res);
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return res.status(400).json({
      error: 'Validation Error',
      message: 'Invalid data provided',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }

  // Handle validation errors
  if (error.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation Error',
      message: error.message,
      details: error.details || undefined
    });
  }

  // Handle JWT errors
  if (error.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Authentication Error',
      message: 'Invalid token'
    });
  }

  if (error.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Authentication Error',
      message: 'Token expired'
    });
  }

  // Handle business logic errors
  if (error.name === 'BusinessError') {
    return res.status(400).json({
      error: 'Business Logic Error',
      message: error.message,
      code: error.code || 'BUSINESS_ERROR'
    });
  }

  // Handle authorization errors
  if (error.name === 'AuthorizationError') {
    return res.status(403).json({
      error: 'Authorization Error',
      message: error.message || 'Insufficient permissions'
    });
  }

  // Handle not found errors
  if (error.name === 'NotFoundError') {
    return res.status(404).json({
      error: 'Not Found',
      message: error.message || 'Resource not found'
    });
  }

  // Default server error
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' 
      ? error.message 
      : 'An unexpected error occurred',
    timestamp: new Date().toISOString()
  });
};

// ================================
// PRISMA ERROR HANDLER
// ================================

const handlePrismaError = (error, res) => {
  switch (error.code) {
    case 'P2000':
      return res.status(400).json({
        error: 'Validation Error',
        message: 'The provided value is too long for the field',
        field: error.meta?.target
      });

    case 'P2001':
      return res.status(404).json({
        error: 'Not Found',
        message: 'The record you are looking for does not exist'
      });

    case 'P2002':
      return res.status(409).json({
        error: 'Conflict',
        message: 'A record with this information already exists',
        field: error.meta?.target
      });

    case 'P2003':
      return res.status(400).json({
        error: 'Foreign Key Constraint',
        message: 'The referenced record does not exist',
        field: error.meta?.field_name
      });

    case 'P2004':
      return res.status(400).json({
        error: 'Constraint Failed',
        message: 'A constraint failed on the database'
      });

    case 'P2005':
      return res.status(400).json({
        error: 'Invalid Value',
        message: 'The value provided is not valid for the field type',
        field: error.meta?.field_name
      });

    case 'P2006':
      return res.status(400).json({
        error: 'Invalid Value',
        message: 'The provided value is not valid'
      });

    case 'P2007':
      return res.status(400).json({
        error: 'Data Validation Error',
        message: 'Data validation error'
      });

    case 'P2008':
      return res.status(500).json({
        error: 'Query Parsing Error',
        message: 'Failed to parse the query'
      });

    case 'P2009':
      return res.status(500).json({
        error: 'Query Validation Error',
        message: 'Failed to validate the query'
      });

    case 'P2010':
      return res.status(500).json({
        error: 'Raw Query Error',
        message: 'Raw query failed'
      });

    case 'P2011':
      return res.status(400).json({
        error: 'Null Constraint Violation',
        message: 'A required field is missing',
        field: error.meta?.constraint
      });

    case 'P2012':
      return res.status(400).json({
        error: 'Missing Required Value',
        message: 'A required value is missing'
      });

    case 'P2013':
      return res.status(400).json({
        error: 'Missing Required Argument',
        message: 'A required argument is missing',
        field: error.meta?.argument_name
      });

    case 'P2014':
      return res.status(400).json({
        error: 'Relation Violation',
        message: 'The change would violate a relation between models',
        relation: error.meta?.relation_name
      });

    case 'P2015':
      return res.status(404).json({
        error: 'Related Record Not Found',
        message: 'A related record could not be found'
      });

    case 'P2016':
      return res.status(500).json({
        error: 'Query Interpretation Error',
        message: 'Query interpretation error'
      });

    case 'P2017':
      return res.status(400).json({
        error: 'Records Not Connected',
        message: 'The records are not connected'
      });

    case 'P2018':
      return res.status(404).json({
        error: 'Connected Records Not Found',
        message: 'The required connected records were not found'
      });

    case 'P2019':
      return res.status(400).json({
        error: 'Input Error',
        message: 'Input error'
      });

    case 'P2020':
      return res.status(400).json({
        error: 'Value Out of Range',
        message: 'Value out of range for the field type'
      });

    case 'P2021':
      return res.status(404).json({
        error: 'Table Not Found',
        message: 'The table does not exist in the current database'
      });

    case 'P2022':
      return res.status(404).json({
        error: 'Column Not Found',
        message: 'The column does not exist in the current database'
      });

    case 'P2025':
      return res.status(404).json({
        error: 'Record Not Found',
        message: 'An operation failed because it depends on one or more records that were required but not found'
      });

    default:
      return res.status(500).json({
        error: 'Database Error',
        message: 'An unexpected database error occurred',
        code: error.code
      });
  }
};

// ================================
// CUSTOM ERROR CLASSES
// ================================

class BusinessError extends Error {
  constructor(message, code = 'BUSINESS_ERROR') {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
  }
}

class AuthorizationError extends Error {
  constructor(message = 'Insufficient permissions') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

class ValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

// ================================
// ASYNC ERROR WRAPPER
// ================================

const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// ================================
// EXPORTS
// ================================

module.exports = {
  errorHandler,
  handlePrismaError,
  BusinessError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  asyncHandler
};