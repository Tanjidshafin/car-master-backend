const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.pcjdk.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  maxPoolSize: 10,
  minPoolSize: 5,
});

let db = null;

const connectDB = async () => {
  if (!db) {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    db = client.db('CarMaster');
    console.log('Connected to MongoDB');
  }
  return db;
};

const getDB = () => db;

// Graceful shutdown
process.on('SIGINT', async () => {
  await client.close();
  console.log('MongoDB connection closed');
  process.exit(0);
});

module.exports = { connectDB, getDB, ObjectId };
