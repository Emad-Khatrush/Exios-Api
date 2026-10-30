// npm run accounting:setup - creates the missing default accounting setup and prints what it did.
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const mongoose = require('mongoose');
const { runSetup } = require('../seed/setup');

const connectionUrl = process.env.MONGO_URL_2 || process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/exios-admin?directConnection=true';

(async () => {
  try {
    await mongoose.connect(connectionUrl);
    const report = await runSetup();
    console.log(`Created ${report.created.length} items, ${report.existing} already existed.`);
    report.created.forEach((item) => console.log(`  + ${item}`));
  } catch (error) {
    console.error('Setup failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
