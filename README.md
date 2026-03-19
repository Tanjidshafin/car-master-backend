# CarMaster Backend API

A simple, production-ready backend API for CarMaster built with Node.js, Express, and MongoDB.

## 🎯 Philosophy: KISS (Keep It Simple, Stupid)

- **3 files only**: `index.js`, `db.js`, `middleware.js`
- All production features without over-engineering
- Easy to understand and maintain
- Perfect for small to medium projects

## 🚀 Features

✅ **Production-Ready**
- Proper error handling & logging
- Security headers (Helmet.js)
- Input validation
- MongoDB connection pooling
- Graceful shutdown

✅ **Simple Structure**
- No complex folder hierarchies
- Routes defined inline
- Minimal abstractions
- Clear code flow

## 📁 Structure

```
car-master-backend/
├── index.js          # Main app + all routes (133 lines)
├── db.js            # Database connection (34 lines)
├── middleware.js    # All middleware (73 lines)
├── .env             # Environment variables
└── package.json
```

That's it! Just 3 core files.

## 🛠️ Installation

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Update .env with your MongoDB credentials
```

## 🔧 Environment Variables

```env
DB_USER=your_mongodb_username
DB_PASSWORD=your_mongodb_password
PORT=8000
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
```

## 🚦 Running

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

## 📡 API Endpoints

### Cars
- `GET /api/cars` - Get all cars
- `GET /api/car/:id` - Get car by ID

### Favorites
- `GET /api/fav-cars?email=user@example.com` - Get favorites
- `POST /api/like-car` - Add to favorites
  ```json
  { "email": "user@example.com", "carId": "123" }
  ```
- `DELETE /api/delete-car/:id` - Remove from favorites

### System
- `GET /` - API info
- `GET /health` - Health check

## 📝 Response Format

**Success:**
```json
{
  "success": true,
  "data": {...},
  "count": 10
}
```

**Error:**
```json
{
  "success": false,
  "error": "Error message"
}
```

## 🔒 Security Features

- ✅ Helmet.js security headers
- ✅ CORS protection
- ✅ Input validation
- ✅ MongoDB injection prevention
- ✅ Request size limits (10MB)
- ✅ Error sanitization

## 📦 Dependencies

```json
{
  "express": "Web framework",
  "mongodb": "Database driver",
  "cors": "Cross-origin requests",
  "helmet": "Security headers",
  "dotenv": "Environment variables"
}
```

## 🧪 Testing

```bash
# Check if server is running
curl http://localhost:8000/health

# Expected response
{"success":true,"status":"healthy","uptime":123.45}
```

## 🚀 Deployment

Works on any Node.js hosting platform:

**Vercel** (already configured)
```bash
vercel deploy
```

**Traditional hosting**
```bash
NODE_ENV=production node index.js
```

**PM2 (recommended for VPS)**
```bash
npm install -g pm2
pm2 start index.js --name carmaster-api
pm2 save
```

## ⚡ Why This Approach?

**Traditional over-engineered backends:**
- 15+ files spread across 7 folders
- Controllers, services, repositories layers
- Difficult to navigate and understand
- Overkill for simple CRUD operations

**This KISS approach:**
- 3 files, crystal clear structure
- All production features intact
- Maintainable and debuggable
- Perfect for most real-world apps

## 📄 License

ISC

---

**Built with the KISS principle** 💋
