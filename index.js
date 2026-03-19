require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dns = require('dns');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { connectDB, getDB, ObjectId } = require('./db');
const {
  asyncHandler,
  logger,
  validateId,
  validateEmail,
  validateLikeCar,
  validateAdminCarCreate,
  validateAdminCarUpdate,
  errorHandler,
  notFound,
} = require('./middleware');

dns.setServers(['1.1.1.1', '8.8.8.8']);

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 8000;

if (!process.env.DB_USER || !process.env.DB_PASSWORD) {
  console.error('Missing DB_USER or DB_PASSWORD in .env file');
  process.exit(1);
}

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || '*';

app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);
app.use(express.json({ limit: '10mb' }));
app.use(logger);

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

const normalizeEmail = (value) => (value || '').toString().trim().toLowerCase();
const getHeaderEmail = (req) => normalizeEmail(req.headers['x-user-email']);

const requireUser = async (req, res, next) => {
  try {
    const email = getHeaderEmail(req);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(401).json({ success: false, error: 'Valid user email header required' });
    }

    const db = getDB();
    const dbUser = await db.collection('Users').findOne({ email });
    if (!dbUser) {
      return res.status(401).json({ success: false, error: 'User not found. Please login again.' });
    }

    req.dbUser = dbUser;
    next();
  } catch (error) {
    next(error);
  }
};

const requireAdminRole = (req, res, next) => {
  if (req.dbUser.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
};

const requireVendorRole = (req, res, next) => {
  if (req.dbUser.role !== 'vendor') {
    return res.status(403).json({ success: false, error: 'Vendor access required' });
  }
  next();
};

const emitUserNotification = async (db, payload) => {
  const { userEmail, type, message, refId = null } = payload;
  if (!userEmail) return null;
  const normalizedUserEmail = normalizeEmail(userEmail);
  const notification = {
    user_email: normalizedUserEmail,
    type,
    message,
    read: false,
    ref_id: refId,
    created_at: new Date(),
  };
  const result = await db.collection('Notifications').insertOne(notification);
  const recipient = await db.collection('Users').findOne({ email: normalizedUserEmail });
  const fullNotification = await decorateNotification(db, recipient || { email: normalizedUserEmail, role: 'user' }, {
    _id: result.insertedId,
    ...notification,
  });
  io.to(`user:${notification.user_email}`).emit('notification:new', fullNotification);
  return fullNotification;
};

const emitRoleNotifications = async (db, role, payload) => {
  const users = await db
    .collection('Users')
    .find({ role }, { projection: { email: 1 } })
    .toArray();

  const notifications = await Promise.all(
    users
      .map((user) => normalizeEmail(user.email))
      .filter(Boolean)
      .map((email) =>
        emitUserNotification(db, {
          ...payload,
          userEmail: email,
        }),
      ),
  );

  return notifications.filter(Boolean);
};

const projectPublicUser = (userDoc) => {
  if (!userDoc) return null;
  return {
    _id: userDoc._id,
    displayName: userDoc.displayName || userDoc.email,
    email: userDoc.email,
    photoURL: userDoc.photoURL || '',
    location: userDoc.location || '',
    phone: userDoc.phone || '',
    role: userDoc.role || 'user',
  };
};

const buildNotificationRoute = async (db, user, type, refId) => {
  if (!type) return null;

  switch (type) {
    case 'new_message':
      return user.role === 'vendor'
        ? `/vendor/messages?conversationId=${refId}`
        : `/messages?conversationId=${refId}`;
    case 'vendor_request':
      return '/admin/vendor-requests';
    case 'vendor_request_status':
      return '/become-vendor';
    case 'car_assigned':
    case 'listing_status':
      return user.role === 'admin' ? '/admin/cars' : '/vendor/cars';
    case 'vendor_listing_submitted':
      return '/admin/pending-listings';
    case 'favorite_added':
      return user.role === 'admin' ? '/admin/favorites' : '/vendor/cars';
    case 'new_booking':
    case 'new_reservation':
      return user.role === 'vendor' ? '/vendor/bookings' : '/admin';
    case 'booking_status': {
      return user.role === 'vendor' ? '/vendor/bookings' : '/my-bookings';
    }
    case 'reservation_status': {
      return user.role === 'vendor' ? '/vendor/bookings' : '/my-bookings';
    }
    default:
      return '/notifications';
  }
};

const decorateNotification = async (db, user, notification) => ({
  ...notification,
  route: await buildNotificationRoute(db, user, notification.type, notification.ref_id),
});

io.use(async (socket, next) => {
  try {
    const email = normalizeEmail(socket.handshake.auth?.email || socket.handshake.query?.email);
    if (!email) return next(new Error('Unauthorized'));
    const db = getDB();
    const dbUser = await db.collection('Users').findOne({ email });
    if (!dbUser) return next(new Error('Unauthorized'));
    socket.user = dbUser;
    socket.join(`user:${email}`);
    return next();
  } catch (error) {
    return next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.on('chat:join', (conversationId) => {
    if (conversationId) socket.join(`conversation:${conversationId}`);
  });

  socket.on('chat:leave', (conversationId) => {
    if (conversationId) socket.leave(`conversation:${conversationId}`);
  });
});

const toCarDocument = (body) => {
  const specs = body.specs || {
    condition: body.condition,
    year: body.year,
    transmission: body.transmission,
    color: body.color,
    speed: body.speed || '',
  };

  return {
    name: body.name,
    brand: body.brand,
    model: body.model,
    price: Number(body.price),
    image: body.image || (Array.isArray(body.images) ? body.images[0] : ''),
    status: body.status || 'recommended',
    specs,
    description: body.description || '',
    images: Array.isArray(body.images) ? body.images : body.images ? [body.images] : body.image ? [body.image] : [],
    rating: body.rating !== undefined ? Number(body.rating) : 0,
    vendor_id: body.vendor_id || null,
    vendor_name: body.vendor_name || '',
    vendor_email: normalizeEmail(body.vendor_email),
    location: body.location || '',
    contact: body.contact || '',
    fuel_type: body.fuel_type || '',
    mileage: body.mileage || '',
    listing_status: body.listing_status || 'pending',
    inventory_status: body.inventory_status || 'available',
  };
};

const resolveVendorUser = async (db, vendorId) => {
  if (!vendorId) return null;
  if (!ObjectId.isValid(vendorId)) {
    const error = new Error('Invalid vendor_id');
    error.statusCode = 400;
    throw error;
  }

  const approvedRequest = await db.collection('VendorRequests').findOne({ user_id: vendorId, status: 'approved' });
  const vendor = await db.collection('Users').findOne({
    _id: new ObjectId(vendorId),
    $or: [{ role: 'vendor' }, ...(approvedRequest ? [{ email: approvedRequest.email }] : [])],
  });
  if (!vendor) {
    const error = new Error('Vendor not found');
    error.statusCode = 404;
    throw error;
  }
  return vendor;
};

const resolveVendorAssignment = async (db, vendorId) => {
  const vendor = await resolveVendorUser(db, vendorId);
  if (!vendor) {
    return {
      vendor_id: null,
      vendor_name: '',
      vendor_email: '',
    };
  }

  return {
    vendor_id: vendor._id.toString(),
    vendor_name: vendor.displayName || vendor.email,
    vendor_email: normalizeEmail(vendor.email),
  };
};

const sellerLookupStages = [
  {
    $lookup: {
      from: 'Users',
      let: { sellerVendorId: '$vendor_id' },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $ne: ['$$sellerVendorId', null] },
                { $ne: ['$$sellerVendorId', ''] },
                { $eq: [{ $toString: '$_id' }, '$$sellerVendorId'] },
              ],
            },
          },
        },
        {
          $project: {
            displayName: 1,
            email: 1,
            phone: 1,
            location: 1,
            photoURL: 1,
          },
        },
      ],
      as: 'sellerLookup',
    },
  },
  {
    $addFields: {
      seller: {
        $let: {
          vars: { sellerDoc: { $arrayElemAt: ['$sellerLookup', 0] } },
          in: {
            $cond: [
              { $ifNull: ['$$sellerDoc', false] },
              {
                _id: '$$sellerDoc._id',
                displayName: { $ifNull: ['$$sellerDoc.displayName', '$$sellerDoc.email'] },
                email: '$$sellerDoc.email',
                phone: { $ifNull: ['$$sellerDoc.phone', ''] },
                location: { $ifNull: ['$$sellerDoc.location', ''] },
                photoURL: { $ifNull: ['$$sellerDoc.photoURL', ''] },
              },
              null,
            ],
          },
        },
      },
    },
  },
  {
    $project: {
      sellerLookup: 0,
    },
  },
];

const validateVendorCarPayload = (body) => {
  const required = [
    'name',
    'brand',
    'model',
    'year',
    'price',
    'condition',
    'transmission',
    'fuel_type',
    'mileage',
    'color',
    'location',
    'description',
  ];

  for (const field of required) {
    if (!body[field] && !(body.specs && body.specs[field])) {
      return `${field} is required`;
    }
  }

  if (Number.isNaN(Number(body.price)) || Number(body.price) < 0) {
    return 'price must be a non-negative number';
  }
  return null;
};

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'CarMaster API',
    version: '2.0.0',
  });
});

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'healthy', uptime: process.uptime() });
});

app.get(
  '/api/cars',
  asyncHandler(async (req, res) => {
    const db = getDB();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 100);
    const skip = (page - 1) * limit;

    const {
      sortBy = 'default',
      sortOrder = 'desc',
      condition,
      brand,
      transmission,
      minPrice,
      maxPrice,
      minYear,
      maxYear,
      colors,
    } = req.query;

    const match = { $or: [{ listing_status: 'approved' }, { listing_status: { $exists: false } }] };
    if (condition && condition !== 'all') match['specs.condition'] = { $regex: `^${condition}$`, $options: 'i' };
    if (brand && brand !== 'All Makes') match.brand = brand;
    if (transmission && transmission !== 'All') match['specs.transmission'] = transmission;

    if (minPrice || maxPrice) {
      match.price = {};
      if (minPrice !== undefined) match.price.$gte = Number(minPrice);
      if (maxPrice !== undefined) match.price.$lte = Number(maxPrice);
    }

    if (colors) {
      const colorList = colors.split(',').map((color) => color.trim()).filter(Boolean);
      if (colorList.length > 0) match['specs.color'] = { $in: colorList };
    }

    const sortMap = {
      'price-asc': { price: 1, _id: -1 },
      'price-desc': { price: -1, _id: -1 },
      'year-asc': { yearNum: 1, _id: -1 },
      'year-desc': { yearNum: -1, _id: -1 },
      default: { _id: -1 },
    };
    const sort = sortMap[sortBy] || { [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: -1 };

    const pipeline = [
      {
        $addFields: {
          yearNum: {
            $convert: {
              input: '$specs.year',
              to: 'int',
              onError: null,
              onNull: null,
            },
          },
        },
      },
      { $match: match },
    ];

    if (minYear || maxYear) {
      const yearMatch = {};
      if (minYear !== undefined) yearMatch.$gte = Number(minYear);
      if (maxYear !== undefined) yearMatch.$lte = Number(maxYear);
      pipeline.push({ $match: { yearNum: yearMatch } });
    }

    pipeline.push(...sellerLookupStages);

    pipeline.push({
      $facet: {
        data: [{ $sort: sort }, { $skip: skip }, { $limit: limit }],
        totalCount: [{ $count: 'count' }],
      },
    });

    const [result] = await db.collection('Cars').aggregate(pipeline).toArray();
    const cars = (result?.data || []).map((car) => {
      const { yearNum, ...rest } = car;
      return rest;
    });
    const total = result?.totalCount?.[0]?.count || 0;

    res.json({
      success: true,
      count: cars.length,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: cars,
    });
  }),
);

app.get(
  '/api/cars/meta',
  asyncHandler(async (req, res) => {
    const db = getDB();
    const [brands, colors] = await Promise.all([
      db.collection('Cars').distinct('brand', { $or: [{ listing_status: 'approved' }, { listing_status: { $exists: false } }] }),
      db.collection('Cars').distinct('specs.color', { $or: [{ listing_status: 'approved' }, { listing_status: { $exists: false } }] }),
    ]);
    res.json({
      success: true,
      data: { brands: brands.filter(Boolean).sort(), colors: colors.filter(Boolean).sort() },
    });
  }),
);

app.get(
  '/api/car/:id',
  validateId,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const [car] = await db
      .collection('Cars')
      .aggregate([
        {
          $match: {
            _id: new ObjectId(req.params.id),
            $or: [{ listing_status: 'approved' }, { listing_status: { $exists: false } }],
          },
        },
        ...sellerLookupStages,
      ])
      .toArray();
    if (!car) return res.status(404).json({ success: false, error: 'Car not found' });
    res.json({ success: true, data: car });
  }),
);

app.get(
  '/api/vendors/:vendorId',
  asyncHandler(async (req, res) => {
    const db = getDB();
    if (!ObjectId.isValid(req.params.vendorId)) {
      return res.status(400).json({ success: false, error: 'Invalid vendor id' });
    }
    const vendor = await resolveVendorUser(db, req.params.vendorId);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });
    const cars = await db
      .collection('Cars')
      .aggregate([
        {
          $match: {
            $and: [
              {
                $or: [
                  { vendor_id: vendor._id.toString() },
                  { vendor_email: normalizeEmail(vendor.email) },
                ],
              },
              {
                $or: [{ listing_status: 'approved' }, { listing_status: { $exists: false } }],
              },
            ],
          },
        },
        ...sellerLookupStages,
        { $sort: { _id: -1 } },
      ])
      .toArray();
    res.json({
      success: true,
      data: {
        vendor: {
          _id: vendor._id,
          displayName: vendor.displayName,
          email: vendor.email,
          phone: vendor.phone || '',
          location: vendor.location || '',
          photoURL: vendor.photoURL || '',
          rating: vendor.rating || null,
        },
        cars,
      },
    });
  }),
);

app.get(
  '/api/fav-cars',
  validateEmail,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const favorites = await db.collection('Favourites').find({ email: req.query.email }).toArray();
    res.json({ success: true, count: favorites.length, data: favorites });
  }),
);

app.post(
  '/api/like-car',
  validateLikeCar,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const existing = await db.collection('Favourites').findOne({
      email: req.body.email,
      carId: req.body.carId,
    });
    if (existing) return res.status(400).json({ success: false, error: 'Already in favorites' });
    const result = await db.collection('Favourites').insertOne({ ...req.body, createdAt: new Date() });
    const likedCar = ObjectId.isValid(req.body.carId)
      ? await db.collection('Cars').findOne({ _id: new ObjectId(req.body.carId) })
      : null;

    if (likedCar?.vendor_email) {
      await emitUserNotification(db, {
        userEmail: likedCar.vendor_email,
        type: 'favorite_added',
        message: `${req.body.email} added ${likedCar.name} to favorites`,
        refId: req.body.carId,
      });
    }

    await emitRoleNotifications(db, 'admin', {
      type: 'favorite_added',
      message: `${req.body.email} added ${likedCar?.name || 'a car'} to favorites`,
      refId: req.body.carId,
    });

    res.status(201).json({
      success: true,
      message: 'Added to favorites',
      data: { _id: result.insertedId, ...req.body },
    });
  }),
);

app.delete(
  '/api/delete-car/:id',
  validateId,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const result = await db.collection('Favourites').deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, error: 'Favorite not found' });
    }
    res.json({ success: true, message: 'Removed from favorites' });
  }),
);

app.put(
  '/api/users/sync',
  validateEmail,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const email = normalizeEmail(req.body.email);
    const existing = await db.collection('Users').findOne({ email });

    const basePayload = {
      email,
      uid: req.body.uid || null,
      displayName: req.body.displayName || '',
      photoURL: req.body.photoURL || '',
      updatedAt: new Date(),
    };

    if (existing) {
      await db.collection('Users').updateOne({ _id: existing._id }, { $set: basePayload });
      const updatedUser = await db.collection('Users').findOne({ _id: existing._id });
      return res.json({ success: true, data: updatedUser });
    }

    const newUser = { ...basePayload, role: 'user', createdAt: new Date() };
    const result = await db.collection('Users').insertOne(newUser);
    return res.status(201).json({ success: true, data: { _id: result.insertedId, ...newUser } });
  }),
);

app.get(
  '/api/users/me-role',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: {
        _id: req.dbUser._id,
        email: req.dbUser.email,
        role: req.dbUser.role || 'user',
        displayName: req.dbUser.displayName || '',
      },
    });
  }),
);

app.get(
  '/api/users/me',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: {
        _id: req.dbUser._id,
        email: req.dbUser.email,
        role: req.dbUser.role || 'user',
        displayName: req.dbUser.displayName || '',
        photoURL: req.dbUser.photoURL || '',
        phone: req.dbUser.phone || '',
        location: req.dbUser.location || '',
        createdAt: req.dbUser.createdAt || null,
        updatedAt: req.dbUser.updatedAt || null,
      },
    });
  }),
);

app.patch(
  '/api/users/me',
  requireUser,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const updatePayload = {
      displayName: typeof req.body.displayName === 'string' ? req.body.displayName.trim() : req.dbUser.displayName || '',
      photoURL: typeof req.body.photoURL === 'string' ? req.body.photoURL.trim() : req.dbUser.photoURL || '',
      phone: typeof req.body.phone === 'string' ? req.body.phone.trim() : req.dbUser.phone || '',
      location: typeof req.body.location === 'string' ? req.body.location.trim() : req.dbUser.location || '',
      updatedAt: new Date(),
    };

    await db.collection('Users').updateOne({ _id: req.dbUser._id }, { $set: updatePayload });
    const updatedUser = await db.collection('Users').findOne({ _id: req.dbUser._id });

    res.json({
      success: true,
      data: {
        _id: updatedUser._id,
        email: updatedUser.email,
        role: updatedUser.role || 'user',
        displayName: updatedUser.displayName || '',
        photoURL: updatedUser.photoURL || '',
        phone: updatedUser.phone || '',
        location: updatedUser.location || '',
        createdAt: updatedUser.createdAt || null,
        updatedAt: updatedUser.updatedAt || null,
      },
    });
  }),
);

app.post(
  '/api/vendor-requests',
  requireUser,
  asyncHandler(async (req, res) => {
    if (req.dbUser.role === 'vendor' || req.dbUser.role === 'admin') {
      return res.status(400).json({ success: false, error: 'You already have elevated access' });
    }

    const db = getDB();
    const existing = await db
      .collection('VendorRequests')
      .findOne({ email: req.dbUser.email, status: { $in: ['pending', 'approved'] } });
    if (existing) return res.status(400).json({ success: false, error: 'Vendor request already exists' });

    const payload = {
      user_id: req.dbUser._id.toString(),
      email: req.dbUser.email,
      business_name: req.body.business_name || '',
      phone: req.body.phone || '',
      location: req.body.location || '',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection('VendorRequests').insertOne(payload);
    await emitRoleNotifications(db, 'admin', {
      type: 'vendor_request',
      message: `${req.dbUser.displayName || req.dbUser.email} submitted a vendor request`,
      refId: result.insertedId.toString(),
    });
    res.status(201).json({ success: true, data: { _id: result.insertedId, ...payload } });
  }),
);

app.get('/api/admin/me', requireUser, requireAdminRole, (req, res) => {
  res.json({ success: true, data: { email: req.dbUser.email, isAdmin: true } });
});

app.get(
  '/api/admin/vendor-requests',
  requireUser,
  requireAdminRole,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const status = req.query.status;
    const query = status ? { status } : {};
    const requests = await db.collection('VendorRequests').find(query).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, count: requests.length, data: requests });
  }),
);

app.patch(
  '/api/admin/vendor-requests/:id',
  requireUser,
  requireAdminRole,
  validateId,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const status = req.body.status;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, error: 'status must be approved or rejected' });
    }

    const request = await db.collection('VendorRequests').findOne({ _id: new ObjectId(req.params.id) });
    if (!request) return res.status(404).json({ success: false, error: 'Vendor request not found' });

    await db.collection('VendorRequests').updateOne(
      { _id: request._id },
      { $set: { status, updatedAt: new Date() } },
    );

    if (status === 'approved') {
      await db.collection('Users').updateOne({ email: request.email }, { $set: { role: 'vendor', updatedAt: new Date() } });
    }

    await emitUserNotification(db, {
      userEmail: request.email,
      type: 'vendor_request_status',
      message: `Your vendor request has been ${status}`,
      refId: request._id.toString(),
    });

    const updated = await db.collection('VendorRequests').findOne({ _id: request._id });
    res.json({ success: true, data: updated });
  }),
);

app.get(
  '/api/admin/vendors',
  requireUser,
  requireAdminRole,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const search = (req.query.q || '').trim();
    const approvedRequests = await db
      .collection('VendorRequests')
      .find({ status: 'approved' }, { projection: { user_id: 1, email: 1, business_name: 1, location: 1 } })
      .toArray();

    const approvedEmails = approvedRequests.map((item) => normalizeEmail(item.email)).filter(Boolean);
    const approvedByEmail = new Map(approvedRequests.map((item) => [normalizeEmail(item.email), item]));

    const users = await db
      .collection('Users')
      .find(
        {
          $or: [{ role: 'vendor' }, { email: { $in: approvedEmails } }],
        },
        { projection: { displayName: 1, email: 1, photoURL: 1, location: 1, role: 1 } },
      )
      .toArray();

    const vendors = users
      .map((user) => {
        const approved = approvedByEmail.get(normalizeEmail(user.email));
        return {
          _id: user._id,
          displayName: user.displayName || approved?.business_name || user.email,
          email: user.email,
          photoURL: user.photoURL || '',
          location: user.location || approved?.location || '',
          business_name: approved?.business_name || '',
          role: user.role || 'user',
        };
      })
      .filter((vendor) => {
        if (!search) return true;
        const term = search.toLowerCase();
        return [vendor.displayName, vendor.email, vendor.location, vendor.business_name]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(term));
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.email.localeCompare(b.email));

    res.json({ success: true, count: vendors.length, data: vendors });
  }),
);

app.get(
  '/api/admin/cars',
  requireUser,
  requireAdminRole,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const cars = await db.collection('Cars').find().sort({ _id: -1 }).toArray();
    res.json({ success: true, count: cars.length, data: cars });
  }),
);

app.post(
  '/api/admin/cars',
  requireUser,
  requireAdminRole,
  validateAdminCarCreate,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const vendorAssignment = await resolveVendorAssignment(db, req.body.vendor_id || null);
    const payload = {
      ...toCarDocument(req.body),
      ...vendorAssignment,
      listing_status: req.body.listing_status || 'approved',
      inventory_status: req.body.inventory_status || 'available',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await db.collection('Cars').insertOne(payload);

    if (payload.vendor_email) {
      await emitUserNotification(db, {
        userEmail: payload.vendor_email,
        type: 'car_assigned',
        message: `A new car "${payload.name}" has been assigned to you`,
        refId: result.insertedId.toString(),
      });
    }

    res.status(201).json({ success: true, message: 'Car created successfully', data: { _id: result.insertedId, ...payload } });
  }),
);

app.patch(
  '/api/admin/cars/:id',
  requireUser,
  requireAdminRole,
  validateId,
  validateAdminCarUpdate,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const existingCar = await db.collection('Cars').findOne({ _id: new ObjectId(req.params.id) });
    if (!existingCar) return res.status(404).json({ success: false, error: 'Car not found' });
    const updatePayload = { ...req.body, updatedAt: new Date() };
    if (updatePayload.price !== undefined) updatePayload.price = Number(updatePayload.price);
    if (updatePayload.rating !== undefined) updatePayload.rating = Number(updatePayload.rating);
    if (Object.prototype.hasOwnProperty.call(updatePayload, 'vendor_id')) {
      const vendorAssignment = await resolveVendorAssignment(db, updatePayload.vendor_id || null);
      updatePayload.vendor_id = vendorAssignment.vendor_id;
      updatePayload.vendor_name = vendorAssignment.vendor_name;
      updatePayload.vendor_email = vendorAssignment.vendor_email;
    }

    const result = await db
      .collection('Cars')
      .updateOne({ _id: new ObjectId(req.params.id) }, { $set: updatePayload });
    const updatedCar = await db.collection('Cars').findOne({ _id: new ObjectId(req.params.id) });

    if (Object.prototype.hasOwnProperty.call(updatePayload, 'vendor_id') && updatedCar?.vendor_email && existingCar.vendor_id !== updatedCar.vendor_id) {
      await emitUserNotification(db, {
        userEmail: updatedCar.vendor_email,
        type: 'car_assigned',
        message: `The car "${updatedCar.name}" has been assigned to you`,
        refId: updatedCar._id.toString(),
      });
    }

    res.json({ success: true, message: 'Car updated successfully', data: updatedCar });
  }),
);

app.delete(
  '/api/admin/cars/:id',
  requireUser,
  requireAdminRole,
  validateId,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const result = await db.collection('Cars').deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, error: 'Car not found' });
    res.json({ success: true, message: 'Car deleted successfully' });
  }),
);

app.get(
  '/api/admin/cars/pending',
  requireUser,
  requireAdminRole,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const cars = await db.collection('Cars').find({ listing_status: 'pending' }).sort({ _id: -1 }).toArray();
    res.json({ success: true, count: cars.length, data: cars });
  }),
);

app.patch(
  '/api/admin/cars/:id/moderate',
  requireUser,
  requireAdminRole,
  validateId,
  asyncHandler(async (req, res) => {
    const { status, reason = '' } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, error: 'status must be approved or rejected' });
    }

    const db = getDB();
    const result = await db.collection('Cars').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { listing_status: status, moderation_reason: reason, updatedAt: new Date() } },
    );
    if (result.matchedCount === 0) return res.status(404).json({ success: false, error: 'Car not found' });
    const car = await db.collection('Cars').findOne({ _id: new ObjectId(req.params.id) });

    if (car?.vendor_email) {
      await emitUserNotification(db, {
        userEmail: car.vendor_email,
        type: 'listing_status',
        message: `Your listing "${car.name}" was ${status}`,
        refId: car._id.toString(),
      });
    }

    res.json({ success: true, data: car });
  }),
);

app.get(
  '/api/admin/favorites',
  requireUser,
  requireAdminRole,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const query = {};
    if (req.query.email) {
      const email = normalizeEmail(req.query.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, error: 'Valid email required' });
      }
      query.email = email;
    }
    const favorites = await db.collection('Favourites').find(query).sort({ _id: -1 }).toArray();
    res.json({ success: true, count: favorites.length, data: favorites });
  }),
);

app.get(
  '/api/vendor/cars',
  requireUser,
  requireVendorRole,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const cars = await db
      .collection('Cars')
      .find({ vendor_email: req.dbUser.email })
      .sort({ _id: -1 })
      .toArray();
    res.json({ success: true, count: cars.length, data: cars });
  }),
);

app.post(
  '/api/vendor/cars',
  requireUser,
  requireVendorRole,
  asyncHandler(async (req, res) => {
    const validationError = validateVendorCarPayload(req.body);
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    const db = getDB();
    const payload = toCarDocument({
      ...req.body,
      vendor_id: req.dbUser._id.toString(),
      vendor_name: req.dbUser.displayName || req.dbUser.email,
      vendor_email: req.dbUser.email,
      listing_status: 'pending',
      inventory_status: 'available',
      contact: req.body.contact || req.dbUser.phone || '',
    });
    payload.createdAt = new Date();
    payload.updatedAt = new Date();

    const result = await db.collection('Cars').insertOne(payload);
    await emitRoleNotifications(db, 'admin', {
      type: 'vendor_listing_submitted',
      message: `${req.dbUser.displayName || req.dbUser.email} submitted "${payload.name}" for review`,
      refId: result.insertedId.toString(),
    });
    res.status(201).json({ success: true, data: { _id: result.insertedId, ...payload } });
  }),
);

app.patch(
  '/api/vendor/cars/:id',
  requireUser,
  requireVendorRole,
  validateId,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const existing = await db.collection('Cars').findOne({
      _id: new ObjectId(req.params.id),
      vendor_email: req.dbUser.email,
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Car not found' });

    const updatePayload = toCarDocument({
      ...existing,
      ...req.body,
      vendor_id: existing.vendor_id,
      vendor_name: existing.vendor_name,
      vendor_email: existing.vendor_email,
      listing_status: 'pending',
    });
    updatePayload.updatedAt = new Date();
    await db.collection('Cars').updateOne({ _id: existing._id }, { $set: updatePayload });
    const updated = await db.collection('Cars').findOne({ _id: existing._id });
    res.json({ success: true, data: updated });
  }),
);

app.delete(
  '/api/vendor/cars/:id',
  requireUser,
  requireVendorRole,
  validateId,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const result = await db.collection('Cars').deleteOne({
      _id: new ObjectId(req.params.id),
      vendor_email: req.dbUser.email,
    });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, error: 'Car not found' });
    res.json({ success: true, message: 'Car deleted successfully' });
  }),
);

app.patch(
  '/api/vendor/cars/:id/mark-sold',
  requireUser,
  requireVendorRole,
  validateId,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const result = await db.collection('Cars').updateOne(
      { _id: new ObjectId(req.params.id), vendor_email: req.dbUser.email },
      { $set: { inventory_status: 'sold', updatedAt: new Date() } },
    );
    if (result.matchedCount === 0) return res.status(404).json({ success: false, error: 'Car not found' });
    const updated = await db.collection('Cars').findOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true, data: updated });
  }),
);

app.post(
  '/api/chat/conversations',
  requireUser,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const { vendor_id, car_id } = req.body;
    if (!vendor_id || !car_id) {
      return res.status(400).json({ success: false, error: 'vendor_id and car_id are required' });
    }
    if (!ObjectId.isValid(vendor_id) || !ObjectId.isValid(car_id)) {
      return res.status(400).json({ success: false, error: 'Invalid vendor_id or car_id' });
    }

    const vendor = await resolveVendorUser(db, vendor_id);
    const car = await db.collection('Cars').findOne({ _id: new ObjectId(car_id) });
    if (!vendor || !car) return res.status(404).json({ success: false, error: 'Vendor or car not found' });

    const buyerEmail = req.dbUser.email;
    const vendorEmail = vendor.email;
    const existing = await db.collection('Conversations').findOne({
      buyer_email: buyerEmail,
      vendor_email: vendorEmail,
      car_id,
    });

    if (existing) {
      await db.collection('Conversations').updateOne(
        { _id: existing._id },
        { $pull: { hidden_for: buyerEmail } },
      );
      const restored = await db.collection('Conversations').findOne({ _id: existing._id });
      return res.json({ success: true, data: restored });
    }

    const payload = {
      buyer_email: buyerEmail,
      vendor_email: vendorEmail,
      buyer_id: req.dbUser._id.toString(),
      vendor_id: vendor._id.toString(),
      car_id,
      car_name: car.name,
      participants: [buyerEmail, vendorEmail],
      createdAt: new Date(),
      updatedAt: new Date(),
      last_message: '',
      last_message_at: null,
      hidden_for: [],
    };

    const result = await db.collection('Conversations').insertOne(payload);
    res.status(201).json({ success: true, data: { _id: result.insertedId, ...payload } });
  }),
);

app.get(
  '/api/chat/conversations',
  requireUser,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const conversations = await db
      .collection('Conversations')
      .aggregate([
        {
          $match: {
            participants: req.dbUser.email,
            $or: [{ hidden_for: { $exists: false } }, { hidden_for: { $ne: req.dbUser.email } }],
          },
        },
        {
          $lookup: {
            from: 'Users',
            localField: 'buyer_email',
            foreignField: 'email',
            as: 'buyerLookup',
          },
        },
        {
          $lookup: {
            from: 'Users',
            localField: 'vendor_email',
            foreignField: 'email',
            as: 'vendorLookup',
          },
        },
        {
          $lookup: {
            from: 'Cars',
            let: { carObjectId: { $convert: { input: '$car_id', to: 'objectId', onError: null, onNull: null } } },
            pipeline: [
              { $match: { $expr: { $eq: ['$_id', '$$carObjectId'] } } },
              { $project: { name: 1, image: 1 } },
            ],
            as: 'carLookup',
          },
        },
        {
          $addFields: {
            buyer: { $arrayElemAt: ['$buyerLookup', 0] },
            vendor: { $arrayElemAt: ['$vendorLookup', 0] },
            car: { $arrayElemAt: ['$carLookup', 0] },
          },
        },
        {
          $addFields: {
            counterpart: {
              $cond: [{ $eq: [req.dbUser.email, '$buyer_email'] }, '$vendor', '$buyer'],
            },
          },
        },
        {
          $project: {
            buyerLookup: 0,
            vendorLookup: 0,
            carLookup: 0,
          },
        },
        { $sort: { updatedAt: -1, last_message_at: -1, _id: -1 } },
      ])
      .toArray();

    const data = conversations.map((conversation) => ({
      ...conversation,
      buyer: projectPublicUser(conversation.buyer),
      vendor: projectPublicUser(conversation.vendor),
      counterpart: projectPublicUser(conversation.counterpart),
      car_image: conversation.car?.image || '',
    }));

    res.json({ success: true, count: data.length, data });
  }),
);

app.patch(
  '/api/chat/conversations/:id/hide',
  requireUser,
  validateId,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const conversation = await db.collection('Conversations').findOne({
      _id: new ObjectId(req.params.id),
      participants: req.dbUser.email,
    });

    if (!conversation) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    await db.collection('Conversations').updateOne(
      { _id: conversation._id },
      { $addToSet: { hidden_for: req.dbUser.email } },
    );

    res.json({ success: true, message: 'Conversation removed from your inbox' });
  }),
);

app.get(
  '/api/chat/messages',
  requireUser,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const conversationId = req.query.conversationId;
    if (!conversationId || !ObjectId.isValid(conversationId)) {
      return res.status(400).json({ success: false, error: 'Valid conversationId is required' });
    }

    const conversation = await db.collection('Conversations').findOne({ _id: new ObjectId(conversationId) });
    if (!conversation || !conversation.participants.includes(req.dbUser.email)) {
      return res.status(403).json({ success: false, error: 'Conversation access denied' });
    }

    const messages = await db
      .collection('Messages')
      .aggregate([
        { $match: { conversation_id: conversationId } },
        {
          $lookup: {
            from: 'Users',
            localField: 'sender_email',
            foreignField: 'email',
            as: 'senderLookup',
          },
        },
        {
          $addFields: {
            sender: { $arrayElemAt: ['$senderLookup', 0] },
          },
        },
        {
          $project: {
            senderLookup: 0,
          },
        },
        { $sort: { createdAt: 1, _id: 1 } },
      ])
      .toArray();

    const data = messages.map((message) => ({
      ...message,
      sender: projectPublicUser(message.sender),
    }));

    res.json({ success: true, count: data.length, data });
  }),
);

app.post(
  '/api/chat/messages',
  requireUser,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const { conversation_id, text } = req.body;
    if (!conversation_id || !ObjectId.isValid(conversation_id)) {
      return res.status(400).json({ success: false, error: 'Valid conversation_id is required' });
    }
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Message text is required' });
    }

    const conversation = await db.collection('Conversations').findOne({ _id: new ObjectId(conversation_id) });
    if (!conversation || !conversation.participants.includes(req.dbUser.email)) {
      return res.status(403).json({ success: false, error: 'Conversation access denied' });
    }

    const payload = {
      conversation_id,
      sender_email: req.dbUser.email,
      sender_id: req.dbUser._id.toString(),
      text: text.trim(),
      createdAt: new Date(),
    };

    const result = await db.collection('Messages').insertOne(payload);
    const message = { _id: result.insertedId, ...payload, sender: projectPublicUser(req.dbUser) };

    await db.collection('Conversations').updateOne(
      { _id: conversation._id },
      {
        $set: {
          updatedAt: new Date(),
          last_message: message.text,
          last_message_at: message.createdAt,
          hidden_for: [],
        },
      },
    );

    const recipientEmail = conversation.participants.find((email) => email !== req.dbUser.email);
    await emitUserNotification(db, {
      userEmail: recipientEmail,
      type: 'new_message',
      message: `New message about ${conversation.car_name}`,
      refId: conversation._id.toString(),
    });

    io.to(`conversation:${conversation_id}`).emit('chat:message:new', message);
    io.to(`user:${recipientEmail}`).emit('chat:message:new', message);
    res.status(201).json({ success: true, data: message });
  }),
);

app.post(
  '/api/bookings',
  requireUser,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const { car_id, name, phone, date, time, message = '' } = req.body;
    if (!car_id || !ObjectId.isValid(car_id)) {
      return res.status(400).json({ success: false, error: 'Valid car_id is required' });
    }
    if (!name || !phone || !date || !time) {
      return res.status(400).json({ success: false, error: 'name, phone, date, and time are required' });
    }

    const car = await db.collection('Cars').findOne({ _id: new ObjectId(car_id) });
    if (!car) return res.status(404).json({ success: false, error: 'Car not found' });
    if (!car.vendor_email) return res.status(400).json({ success: false, error: 'This car has no assigned vendor' });

    const payload = {
      car_id,
      car_name: car.name,
      user_id: req.dbUser._id.toString(),
      user_email: req.dbUser.email,
      vendor_id: car.vendor_id || null,
      vendor_email: car.vendor_email,
      customer_name: name,
      phone,
      booking_date: date,
      booking_time: time,
      status: 'pending',
      notes: message,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection('Bookings').insertOne(payload);
    const booking = { _id: result.insertedId, ...payload };

    await emitUserNotification(db, {
      userEmail: car.vendor_email,
      type: 'new_booking',
      message: `New test drive booking for ${car.name}`,
      refId: booking._id.toString(),
    });
    await emitRoleNotifications(db, 'admin', {
      type: 'new_booking',
      message: `${req.dbUser.email} booked a test drive for ${car.name}`,
      refId: booking._id.toString(),
    });
    res.status(201).json({ success: true, data: booking });
  }),
);

app.get(
  '/api/vendor/bookings',
  requireUser,
  requireVendorRole,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const bookings = await db
      .collection('Bookings')
      .find({ vendor_email: req.dbUser.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ success: true, count: bookings.length, data: bookings });
  }),
);

app.get(
  '/api/bookings/me',
  requireUser,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const bookings = await db
      .collection('Bookings')
      .find({ user_email: req.dbUser.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ success: true, count: bookings.length, data: bookings });
  }),
);

app.patch(
  '/api/vendor/bookings/:id/status',
  requireUser,
  requireVendorRole,
  validateId,
  asyncHandler(async (req, res) => {
    const status = req.body.status;
    if (!['pending', 'approved', 'rejected', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid booking status' });
    }
    const db = getDB();
    const booking = await db.collection('Bookings').findOne({
      _id: new ObjectId(req.params.id),
      vendor_email: req.dbUser.email,
    });
    if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });

    await db.collection('Bookings').updateOne(
      { _id: booking._id },
      { $set: { status, updatedAt: new Date() } },
    );

    await emitUserNotification(db, {
      userEmail: booking.user_email,
      type: 'booking_status',
      message: `Your booking for ${booking.car_name} is ${status}`,
      refId: booking._id.toString(),
    });

    const updated = await db.collection('Bookings').findOne({ _id: booking._id });
    res.json({ success: true, data: updated });
  }),
);

app.post(
  '/api/reservations',
  requireUser,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const { car_id, deposit = 0, message = '' } = req.body;
    if (!car_id || !ObjectId.isValid(car_id)) {
      return res.status(400).json({ success: false, error: 'Valid car_id is required' });
    }
    if (Number.isNaN(Number(deposit)) || Number(deposit) < 0) {
      return res.status(400).json({ success: false, error: 'Deposit must be a non-negative number' });
    }

    const car = await db.collection('Cars').findOne({ _id: new ObjectId(car_id) });
    if (!car) return res.status(404).json({ success: false, error: 'Car not found' });
    if (!car.vendor_email) return res.status(400).json({ success: false, error: 'This car has no assigned vendor' });

    const payload = {
      car_id,
      car_name: car.name,
      user_id: req.dbUser._id.toString(),
      user_email: req.dbUser.email,
      vendor_id: car.vendor_id || null,
      vendor_email: car.vendor_email,
      deposit: Number(deposit),
      status: 'pending',
      note: message,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const result = await db.collection('Reservations').insertOne(payload);
    const reservation = { _id: result.insertedId, ...payload };

    await emitUserNotification(db, {
      userEmail: car.vendor_email,
      type: 'new_reservation',
      message: `New reservation request for ${car.name}`,
      refId: reservation._id.toString(),
    });
    await emitRoleNotifications(db, 'admin', {
      type: 'new_reservation',
      message: `${req.dbUser.email} reserved ${car.name}`,
      refId: reservation._id.toString(),
    });

    res.status(201).json({ success: true, data: reservation });
  }),
);

app.get(
  '/api/vendor/reservations',
  requireUser,
  requireVendorRole,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const reservations = await db
      .collection('Reservations')
      .find({ vendor_email: req.dbUser.email })
      .sort({ created_at: -1 })
      .toArray();
    res.json({ success: true, count: reservations.length, data: reservations });
  }),
);

app.get(
  '/api/reservations/me',
  requireUser,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const reservations = await db
      .collection('Reservations')
      .find({ user_email: req.dbUser.email })
      .sort({ created_at: -1 })
      .toArray();
    res.json({ success: true, count: reservations.length, data: reservations });
  }),
);

app.patch(
  '/api/vendor/reservations/:id/status',
  requireUser,
  requireVendorRole,
  validateId,
  asyncHandler(async (req, res) => {
    const status = req.body.status;
    if (!['pending', 'confirmed', 'cancelled'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid reservation status' });
    }
    const db = getDB();
    const reservation = await db.collection('Reservations').findOne({
      _id: new ObjectId(req.params.id),
      vendor_email: req.dbUser.email,
    });
    if (!reservation) return res.status(404).json({ success: false, error: 'Reservation not found' });

    await db.collection('Reservations').updateOne(
      { _id: reservation._id },
      { $set: { status, updated_at: new Date() } },
    );

    if (status === 'confirmed') {
      await db.collection('Cars').updateOne(
        { _id: new ObjectId(reservation.car_id) },
        { $set: { inventory_status: 'reserved', updatedAt: new Date() } },
      );
    }

    await emitUserNotification(db, {
      userEmail: reservation.user_email,
      type: 'reservation_status',
      message: `Your reservation for ${reservation.car_name} is ${status}`,
      refId: reservation._id.toString(),
    });

    const updated = await db.collection('Reservations').findOne({ _id: reservation._id });
    res.json({ success: true, data: updated });
  }),
);

app.get(
  '/api/notifications',
  requireUser,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const notifications = await db
      .collection('Notifications')
      .find({ user_email: req.dbUser.email })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();
    const data = await Promise.all(notifications.map((notification) => decorateNotification(db, req.dbUser, notification)));
    res.json({ success: true, count: data.length, data });
  }),
);

app.patch(
  '/api/notifications/:id/read',
  requireUser,
  validateId,
  asyncHandler(async (req, res) => {
    const db = getDB();
    const notification = await db.collection('Notifications').findOne({
      _id: new ObjectId(req.params.id),
      user_email: req.dbUser.email,
    });
    if (!notification) return res.status(404).json({ success: false, error: 'Notification not found' });

    await db.collection('Notifications').updateOne({ _id: notification._id }, { $set: { read: true } });
    io.to(`user:${req.dbUser.email}`).emit('notification:read', { id: notification._id.toString() });
    res.json({ success: true, message: 'Notification marked as read' });
  }),
);

app.patch(
  '/api/notifications/read-all',
  requireUser,
  asyncHandler(async (req, res) => {
    const db = getDB();
    await db.collection('Notifications').updateMany({ user_email: req.dbUser.email, read: false }, { $set: { read: true } });
    io.to(`user:${req.dbUser.email}`).emit('notification:read-all');
    res.json({ success: true, message: 'All notifications marked as read' });
  }),
);

app.use(notFound);
app.use(errorHandler);

connectDB()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to database:', err);
    process.exit(1);
  });
