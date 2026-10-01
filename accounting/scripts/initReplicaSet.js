// One-time step for a LOCAL MongoDB started with replSetName (accounting needs transactions):
// makes the server a single-node replica set. Safe to run again.
const { MongoClient } = require('mongodb');

const url = process.argv[2] || 'mongodb://127.0.0.1:27017/?directConnection=true';

(async () => {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const admin = client.db('admin');
  try {
    const status = await admin.command({ replSetGetStatus: 1 });
    console.log(`Already a replica set: ${status.set}`);
  } catch (error) {
    if (error.codeName !== 'NotYetInitialized') throw error;
    await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] } });
    console.log('Replica set rs0 initiated');
  }
  for (let i = 0; i < 30; i++) {
    const hello = await admin.command({ hello: 1 });
    if (hello.isWritablePrimary) { console.log('Server is primary: transactions are available'); break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await client.close();
})().catch((error) => { console.error(error.message); process.exit(1); });
