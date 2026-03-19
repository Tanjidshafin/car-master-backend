const { ObjectId } = require('mongodb');
const admin = require('firebase-admin');

let firebaseInitialized = false;

const getFirebaseAdmin = () => {
  if (!firebaseInitialized) {
    const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
    if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
      const err = new Error('Firebase admin credentials are not configured');
      err.statusCode = 500;
      throw err;
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    firebaseInitialized = true;
  }
  return admin;
};

// Async handler wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Request logger
const logger = (req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
};

// Validate MongoDB ObjectId
const validateId = (req, res, next) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, error: 'Invalid ID format' });
  }
  next();
};

// Validate email
const validateEmail = (req, res, next) => {
  const email = req.query.email || req.body.email;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Valid email required' });
  }
  next();
};

// Validate like car body
const validateLikeCar = (req, res, next) => {
  const { email, carId } = req.body;
  if (!email || !carId) {
    return res.status(400).json({ success: false, error: 'Email and carId required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Invalid email format' });
  }
  next();
};

const verifyAdminToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authorization token required' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, error: 'Authorization token required' });
    }

    const firebaseAdmin = getFirebaseAdmin();
    const decoded = await firebaseAdmin.auth().verifyIdToken(token);
    req.authUser = decoded;
    next();
  } catch (error) {
    const statusCode = error.statusCode || 401;
    res.status(statusCode).json({ success: false, error: 'Invalid or expired token' });
  }
};

const requireAdminEmail = (req, res, next) => {
  const adminEmails =
    process.env.ADMIN_EMAILS?.split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean) || [];

  if (adminEmails.length === 0) {
    return res.status(500).json({ success: false, error: 'ADMIN_EMAILS is not configured' });
  }

  const userEmail = req.authUser?.email?.toLowerCase();
  if (!userEmail || !adminEmails.includes(userEmail)) {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  next();
};

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const validateAdminCarCreate = (req, res, next) => {
  const requiredFields = ['name', 'brand', 'model', 'price', 'image', 'status', 'specs'];
  for (const field of requiredFields) {
    if (req.body[field] === undefined || req.body[field] === null || req.body[field] === '') {
      return res.status(400).json({ success: false, error: `${field} is required` });
    }
  }

  if (Number.isNaN(Number(req.body.price)) || Number(req.body.price) < 0) {
    return res.status(400).json({ success: false, error: 'price must be a non-negative number' });
  }

  if (!isPlainObject(req.body.specs)) {
    return res.status(400).json({ success: false, error: 'specs must be an object' });
  }

  if (req.body.images !== undefined && !Array.isArray(req.body.images)) {
    return res.status(400).json({ success: false, error: 'images must be an array' });
  }

  if (req.body.vendor_id !== undefined && req.body.vendor_id !== null && req.body.vendor_id !== '') {
    if (!ObjectId.isValid(req.body.vendor_id)) {
      return res.status(400).json({ success: false, error: 'vendor_id must be a valid id' });
    }
  }

  next();
};

const validateAdminCarUpdate = (req, res, next) => {
  const allowedFields = ['name', 'brand', 'model', 'price', 'image', 'status', 'specs', 'rating', 'description', 'images', 'vendor_id', 'vendor_name', 'vendor_email'];
  const keys = Object.keys(req.body);

  if (keys.length === 0) {
    return res.status(400).json({ success: false, error: 'At least one field is required for update' });
  }

  const invalidField = keys.find((key) => !allowedFields.includes(key));
  if (invalidField) {
    return res.status(400).json({ success: false, error: `Invalid update field: ${invalidField}` });
  }

  if (req.body.price !== undefined && (Number.isNaN(Number(req.body.price)) || Number(req.body.price) < 0)) {
    return res.status(400).json({ success: false, error: 'price must be a non-negative number' });
  }

  if (req.body.specs !== undefined && !isPlainObject(req.body.specs)) {
    return res.status(400).json({ success: false, error: 'specs must be an object' });
  }

  if (req.body.images !== undefined && !Array.isArray(req.body.images)) {
    return res.status(400).json({ success: false, error: 'images must be an array' });
  }

  if (req.body.vendor_id !== undefined && req.body.vendor_id !== null && req.body.vendor_id !== '') {
    if (!ObjectId.isValid(req.body.vendor_id)) {
      return res.status(400).json({ success: false, error: 'vendor_id must be a valid id' });
    }
  }

  next();
};

// Global error handler
const errorHandler = (err, req, res, next) => {
  console.error('Error:', err.message);
  
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';
  
  if (err.name === 'CastError') {
    statusCode = 400;
    message = 'Invalid ID format';
  }
  
  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

// 404 handler
const notFound = (req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
};

module.exports = {
  asyncHandler,
  logger,
  validateId,
  validateEmail,
  validateLikeCar,
  verifyAdminToken,
  requireAdminEmail,
  validateAdminCarCreate,
  validateAdminCarUpdate,
  errorHandler,
  notFound,
};
