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
const validateCuid = (fieldName) => {
  return (value) => {
    // Accept both CUID format and standard UUID format (with or without dashes)
    const cuidRegex = /^[a-z0-9]{25}$/;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const uuidNoDashesRegex = /^[0-9a-f]{32}$/i;
    
    if (!cuidRegex.test(value) && !uuidRegex.test(value) && !uuidNoDashesRegex.test(value)) {
      throw new Error(`Invalid ${fieldName} format`);
    }
    return true;
  };
};

module.exports = {
  isCuid,
  validateCuid
};