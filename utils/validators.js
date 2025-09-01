// utils/validators.js

/**
 * Validates CUID format
 * CUID format: c + timestamp + counter + fingerprint + random
 * Example: cmf0s9675000iiki5nr661ifk
 */
const isCuid = (value) => {
  const cuidPattern = /^c[a-z0-9]{24}$/;
  return cuidPattern.test(value);
};

/**
 * Custom validator for express-validator to check CUID format
 */
const validateCuid = (fieldName = 'ID') => {
  return (value) => {
    if (!isCuid(value)) {
      throw new Error(`Invalid ${fieldName} format`);
    }
    return true;
  };
};

module.exports = {
  isCuid,
  validateCuid
};