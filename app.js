if (process.env.NODE_ENV !== "production") {
  require('dotenv').config();
}
const express = require('express');
const mongoose = require('mongoose');
const morgan = require('morgan');
const cors = require('cors');
const bodyParser = require('body-parser');
const errorHandler = require('./middleware/error');
const { validatePhoneNumber, imageToBase64, replaceWords, getRandomStep } = require('./utils/messages');
const Queue = require('bull');

// DB Collections
const Users = require('./models/user');

// import routes
const orders = require('./routes/orders');
const users = require('./routes/users');
const expenses = require('./routes/expenses');
const incomes = require('./routes/incomes');
const activities = require('./routes/activities');
const offices = require('./routes/offices');
const sendMessages = require('./routes/sendMessages');
const resetToken = require('./routes/resetToken');
const tasks = require('./routes/tasks');
const settings = require('./routes/settings');
const notifications = require('./routes/notifications');
const balances = require('./routes/balance');
const inventory = require('./routes/inventory');
const wallet = require('./routes/wallet');
const Redis = require('ioredis');

let REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
// Setup Redis connection using ioredis
let redisClient;

// Use TLS for secure Redis connection (Redis Cloud requires TLS)
if (process.env.REDIS_HOST) {
  redisClient = new Redis({
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASS,
  });
} else {
  // Fallback to default local Redis
  redisClient = new Redis(REDIS_URL);
}

// Test Redis connection
redisClient.on('connect', () => {
  console.log('Connected to Redis Cloud!');
});

redisClient.on('error', (err) => {
  console.error('Redis connection error:', err);
});

// Whatsup packages
const { Client, RemoteAuth, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const { isAdmin, protect } = require('./middleware/check-auth');
const { generatePDF } = require('./utils/sender');
const Orders = require('./models/order');

let qrCodeData = null;
let client;

const app = express();

// Initialize Bull queue with Redis client
const sendMessageQueue = new Queue('send-message', {
  redis: {
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASS,
  }
});

const connectionUrl = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/exios-admin?directConnection=true&serverSelectionTimeoutMS=2000&appName=mon'
mongoose.connect(connectionUrl, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(morgan('tiny'));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE');
    
  next();
})
app.use(cors());

//   "whatsapp-web.js": "github:Emad-Khatrush/whatsapp-web.js"
// "whatsapp-web.js": "^1.26.1-alpha.3",

// "--disable-accelerated-2d-canvas",
//       "--disable-background-timer-throttling",
//       "--disable-backgrounding-occluded-windows",
//       "--disable-breakpad",
//       "--disable-cache",
//       "--disable-component-extensions-with-background-pages",
//       "--disable-crash-reporter",
//       "--disable-dev-shm-usage",
//       "--disable-extensions",
//       "--disable-gpu",
//       "--disable-hang-monitor",
//       "--disable-ipc-flooding-protection",
//       "--disable-mojo-local-storage",
//       "--disable-notifications",
//       "--disable-popup-blocking",
//       "--disable-print-preview",
//       "--disable-prompt-on-repost",
//       "--disable-renderer-backgrounding",
//       "--disable-software-rasterizer",
//       "--ignore-certificate-errors",
//       "--log-level=3",
//       "--no-default-browser-check",
//       "--no-first-run",
//       "--no-sandbox",
//       "--no-zygote",
//       "--renderer-process-limit=100",
//       "--enable-gpu-rasterization",
//       "--enable-zero-copy",

const db = mongoose.connection;
db.on("error", console.error.bind(console, "connection error:"));
db.once("open", async () => {
  console.log('MongoDB connected');
  const store = new MongoStore({ mongoose: mongoose });
  const WhatsAppConfig = RemoteAuth;
  client = new Client({
    authStrategy: new WhatsAppConfig({
      store,
      backupSyncIntervalMs: 600000
    }),
    puppeteer: {
      headless: "new",
      executablePath: process.env.CHROME_BIN,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    }
  });
  // client.initialize();

  client.on('qr', (qr) => {

    console.log(qr);
    qrCodeData = qr;
    qrcode.generate(qr, { small: true });
  })

  client.on('ready', () => {
    console.log('WhatsApp client is ready!');
  });

  client.on('loading_screen', (percent, message) => {
    console.log('LOADING SCREEN', percent, message);
  });

  client.on('auth_failure', msg => {
    // Fired if session restore was unsuccessful
    console.error('AUTHENTICATION FAILURE', msg);
  });
  
  client.on('authenticated', (session) => {    
    // Save the session object however you prefer.
    // Convert it to json, save it to a file, store it in a database...
    console.log("authenticated");
  });
  
  client.on('remote_session_saved', () => {
    console.log('Remote Session Saved');
  });

  client.on('disconnected', async (reason) => {
    try {
      if (await store.sessionExists({session: 'RemoteAuth'})) {
        console.log('Deleting session from store');
        await store.delete({ session: 'RemoteAuth' });
      }
      console.log('Client disconnected:', reason); 
      
    } catch (error) {
      console.log('Client disconnected:', reason);
    }
  });
})

// render routes
app.use('/api', users);
app.use('/api', orders);
app.use('/api', expenses);
app.use('/api', activities);
app.use('/api', offices);
app.use('/api', incomes);
app.use('/api', sendMessages);
app.use('/api', resetToken);
app.use('/api', tasks);
app.use('/api', settings);
app.use('/api', notifications);
app.use('/api', balances);
app.use('/api', inventory);
app.use('/api', wallet);

app.get('/api/get-qr-code', (req, res) => {
  if (qrCodeData) {
    res.status(200).json({ qrCode: qrCodeData });
  } else {
    res.status(404).json({ message: 'QR code not available yet' });
  }
});

app.post('/api/sendWhatsupMessage', async (req, res) => {
  const { phoneNumber, message } = req.body
  try {
    const target = await client.getContactById(validatePhoneNumber(phoneNumber));
    if (target) {
      await client.sendMessage(target.id._serialized, message);
      return res.status(200).json({ success: true, message: 'Message sent successfully' });
    } else {
      return res.status(400).json({ success: false, message: 'Contact not found' });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'whatsup-auth-not-found' });
  }
});

app.post('/api/sendWhatsupImages', async (req, res) => {
  const { imgUrls, phoneNumber } = req.body
  try {
    const target = await client.getContactById(validatePhoneNumber(phoneNumber));
    if (target) {
      if (imgUrls && imgUrls.length > 0) {
        for (const imgUrl of imgUrls) {
          const media = new MessageMedia('image/png', await imageToBase64(imgUrl))
          await client.sendMessage(target.id._serialized, media);
        }
      }
      return res.status(200).json({ success: true, message: 'Images sent successfully' });
    } else {
      return res.status(400).json({ success: false, message: 'Contact not found' });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'whatsup-auth-not-found' });
  }
});

app.post('/api/inventorySendWhatsupMessages', protect, async (req, res) => {
  try {
    const { data } = req.body;
    let index = 0;
    for (const user of data) {
      if (user.phoneNumber && `${user.phoneNumber}`.length >= 5) {
        const target = await client.getContactById(validatePhoneNumber(`${user.phoneNumber}@c.us`));
        if (target) {
          const rtlContent = `\u202B${user.message}`;
          await sendMessageQueue.add('send-message', { target, index: index + 1, content: rtlContent }, { delay: index * 10000 });
          index++;
        }
      }
    }
    return res.status(200).json({ success: true, message: 'Messages sent successfully' });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
})

app.post('/api/sendMessagesToClients', protect, isAdmin, async (req, res) => {
  const { imgUrl, content, target, testMode, testBigData, skip, limit } = req.body

  try {
    if (testMode) {
      const target = await client.getContactById(validatePhoneNumber(`5535728209@c.us`));
      if (target) {
        const generetedContent = replaceWords(content, {
          fullName: `Emad Khatrush`,
          customerId: 'A200',
          phone: '+905535728209',
        });
        const rtlContent = `\u202B${generetedContent}`;
        await sendMessageQueue.add('send-message', { target, index: 1, imgUrl, content: rtlContent }, { delay: 1 });
        return res.status(200).json({ success: true, message: 'Message sent successfully' });
      }
    }

    let users;
    if (target === 'onlyNewClients') {
      users = await Users.aggregate([
        {
          $match: {
            'roles.isClient': true,
            isCanceled: false
          }
        },
        {
          $lookup: {
            from: 'orders',
            localField: '_id',
            foreignField: 'user',
            as: 'orders'
          }
        },
        {
          $match: {
            orders: { $size: 0 }
          }
        },
        {
          $project: {
            phone: 1
          }
        },
        {
          $sort: {
            createdAt: -1
          }
        },
        {
          $skip: Number(skip) || 0
        },
        {
          $limit: Number(limit)
        }
      ])
    } else {
      users = await Users.find({ isCanceled: false, 'roles.isClient': true }).select({ phone: 1, firstName: 1, lastName: 1, customerId: 1 }).sort({ createdAt: -1 }).skip(skip).limit(limit);
    }

    const splitCount = 2;
    const usersCount = users.length;
    const rtlContent = `\u202B${content}`;

    const chunkSize = Math.ceil(usersCount / splitCount);

    let currentIndex = 0; // Initialize currentIndex outside the loop

    if (testBigData) {
      const usersTest1 = [];
      const usersTest2 = [];
      for (let index = 0; index < 50; index++) {
        usersTest1.push({
          phone: `111011111${index}`
        })
      }
      for (let index = 51; index < 100; index++) {
        usersTest2.push({
          phone: `111011111${index}`
        })
      }
      const delay = getRandomStep(2000, 5000, 1000);
      await sendMessageQueue.add('send-large-messages', { imgUrl, content: rtlContent, users: usersTest1, index: 1 }, { delay: index * delay });
      await sendMessageQueue.add('send-large-messages', { imgUrl, content: rtlContent, users: usersTest2, index: 2 }, { delay: index * delay });
      return res.status(200).json({ success: true, message: 'Messages sent successfully' });
    } 

    for (let index = 0; index < splitCount; index++) {
      const usersToSend = users.slice(currentIndex, currentIndex + chunkSize);
      const delay = getRandomStep(2000, 5000, 1000);
      // Send message queue for each split, passing the index
      await sendMessageQueue.add('send-large-messages', { imgUrl, content: rtlContent, users: usersToSend, index: currentIndex }, { delay: index * delay });
      
      currentIndex += chunkSize; // Update currentIndex for the next split
    }

    return res.status(200).json({ success: true, message: 'Messages sent successfully' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'whatsup-auth-not-found' });
  }
});

sendMessageQueue.process('resume-jobs', 1, async (job) => {
  // Resume the queue
  await sendMessageQueue.resume();
  console.log('Queue resumed.');
})

sendMessageQueue.process('send-large-messages', 1, async (job) => {
  const { imgUrl, content, users } = job.data;
  
  try {
    
    let index = job.data.index || 0; // Retrieve index from job data or default to 0
    for (const user of users) {
      if (user.phone && `${user.phone}`.length >= 5) {
        const target = await client.getContactById(validatePhoneNumber(`${user.phone}@c.us`));
        if (target) {
          const generetedContent = replaceWords(content, {
            fullName: `${user?.firstName} ${user?.lastName}`,
            customerId: user?.customerId,
            phone: user?.phone,
          });
          const delay = getRandomStep(2000, 5000, 1000);
          const rtlContent = `\u202B${generetedContent}`;
          await sendMessageQueue.add('send-message', { target, index: index + 1, imgUrl, content: rtlContent }, { delay: index * delay });
          index++;
        }
      }
    }
  } catch (error) {
    console.log(`Error processing job, attempt ${index}: ${error?.message}`);
    // Retry the job after a delay of 10 seconds
    await sendMessageQueue.add('send-message', { target, index, imgUrl, content }, { delay: index * 30000 });
    return Promise.resolve();
  }

  return Promise.resolve();
});

sendMessageQueue.process('send-message', 1, async (job) => {
  const { target, index, imgUrl, content } = job.data;

  try {
    if (imgUrl) {
      const media = new MessageMedia('image/png', await imageToBase64(imgUrl))
      await client.sendMessage(target.id._serialized, media);
    }
    await client.sendMessage(target.id._serialized, content);
    console.log("Message Sent " + index + ' !');
    await sendMessageQueue.clean(0);

  } catch (error) {
    console.log(`Error processing job, attempt ${index}: ${error?.message}`);
    // Retry the job after a delay of 10 seconds
    await sendMessageQueue.add('send-message', { target, index, imgUrl, content }, { delay: index * 30000 });
    return Promise.resolve();
  }

  // Introduce a delay of 3 seconds before processing the next job
  await job.delay(5000);

  return Promise.resolve();
});

app.use(async (req, res) => {
  if (req.query.deleteMessages === 'all') {
    await sendMessageQueue.clean(0);
    await sendMessageQueue.clean(0, 'active');
    await sendMessageQueue.clean(0, 'failed');
    await sendMessageQueue.clean(0, 'delayed');
    await sendMessageQueue.clean(0, 'paused');
    await sendMessageQueue.clean(0, 'wait');
    const counts = await sendMessageQueue.getJobCounts();
    console.log("Number of jobs in queue:", counts.waiting + counts.active);
  }

  // const newClients = await Users.aggregate([
  //   {
  //     $match: {
  //       'roles.isClient': true
  //     }
  //   },
  //   {
  //     $lookup: {
  //       from: 'orders',
  //       localField: '_id',
  //       foreignField: 'user',
  //       as: 'orders'
  //     }
  //   },
  //   // {
  //   //   $match: {
  //   //     orders: { $size: 0 }
  //   //   }
  //   // },
  //   {
  //     $sort: {
  //       createdAt: -1
  //     }
  //   }
  // ])

  // let orders = await Orders.aggregate([
  //   {
  //     $match: {
  //       paymentList: {
  //         $elemMatch: {
  //           $or: [
  //             {
  //               'deliveredPackages.weight.total': { $gte: 40 },
  //               'deliveredPackages.weight.measureUnit': 'KG'
  //             },
  //             {
  //               'deliveredPackages.weight.total': { $gte: 3 },
  //               'deliveredPackages.weight.measureUnit': 'CBM'
  //             }
  //           ]
  //         }
  //       }
  //     }
  //   },
  //   {
  //     $sort: { createdAt: -1 } // Optional: get most recent order per user
  //   },
  //   {
  //     $group: {
  //       _id: '$user', // group by user
  //       order: { $first: '$$ROOT' } // take the first order per user
  //     }
  //   },
  //   {
  //     $replaceRoot: { newRoot: '$order' } // flatten structure
  //   }
  // ]);

  // orders = await Orders.populate(orders, [{ path: "user" }]);
  // const users = orders.map(order => order.user);
  
  // generatePDF(users, 'Valued Customers').catch((error) => {
  //   console.error(error);
  // });

  res.status(404).send("Page Not Found 140");
});

// Error Handler
app.use(errorHandler);

const server = app.listen(process.env.PORT || 8000, () => {
  console.log(`Server working on http://localhost:${process.env.PORT || 8000}/`);
})
server.timeout = 600000;
