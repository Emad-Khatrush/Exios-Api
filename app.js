if (process.env.NODE_ENV !== "production") {
  require('dotenv').config();
}
const express = require('express');
const mongoose = require('mongoose');
const morgan = require('morgan');
const cors = require('cors');
const bodyParser = require('body-parser');
const errorHandler = require('./middleware/error');
const { validatePhoneNumber, imageToBase64, replaceWords } = require('./utils/messages');
const Queue = require('bull');
const path = require('path');
const os = require('os');
const qrcode = require('qrcode-terminal');

process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || '/app/.cache/puppeteer';

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
const marketing = require('./routes/marketing');
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
const { Client, MessageMedia } = require('whatsapp-web.js');
const { WhatsAppMongoStore, SafeRemoteAuth } = require('./utils/whatsappStore');
const { isAdmin, protect } = require('./middleware/check-auth');
const { generatePDF } = require('./utils/sender');
const Orders = require('./models/order');

let qrCodeData = null;
let client; // whatsapp-web.js Client instance
let isWhatsAppReady = false;
let isInitializingWhatsApp = false; // guards against overlapping initialize() calls

const app = express();

// Initialize Bull queue with Redis client
const sendMessageQueue = new Queue('send-message', {
  redis: {
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASS,
  }
});

const connectionUrl = process.env.MONGO_URL_2 || process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/exios-admin?directConnection=true&serverSelectionTimeoutMS=2000&appName=mon'
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

const WHATSAPP_DATA_PATH = './.wwebjs_auth/';
let whatsappStore; // created once DB is connected
let isShuttingDown = false;
let isBackupRestart = false; // Chrome is being closed on purpose for a clean backup
let loggedInThisRun = false; // reached 'ready' and hasn't logged out since
let shownQrThisClient = false; // current client needed a QR scan (= new link)

// Closes Chrome and waits for the process to exit, so it has flushed
// IndexedDB and Local Storage to disk before we copy the profile.
async function closeChromeCleanly(waClient) {
  const chrome = waClient.pupBrowser && waClient.pupBrowser.process();
  await Promise.race([
    waClient.destroy().catch(() => {}),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    await new Promise((resolve) => {
      chrome.once('exit', resolve);
      setTimeout(resolve, 8000);
    });
  }
}

// A backup copied while Chrome runs can miss Local Storage (Chrome writes it
// lazily) and catch IndexedDB mid-write, which restores to a QR screen. So
// after a new QR link, briefly close Chrome, back up the flushed profile, and
// reconnect from that backup — which also proves the backup restores.
async function cleanBackupAndReconnect() {
  if (isShuttingDown || !isWhatsAppReady || !client) return;
  console.log('Taking clean WhatsApp session backup (reconnecting in a few seconds)...');
  isBackupRestart = true;
  isWhatsAppReady = false;
  const oldClient = client;
  try {
    await closeChromeCleanly(oldClient);
    if (await oldClient.authStrategy.storeRemoteSession({ emit: true })) {
      console.log('Clean WhatsApp session backup saved to MongoDB. Verifying restore...');
    }
  } finally {
    isBackupRestart = false;
  }
  initializeWhatsAppClient();
}

// Builds a fresh Client and wires up all listeners. Safe to call repeatedly
// (e.g. after a disconnect) — RemoteAuth pulls the saved session back from
// Mongo, so restarts / redeploys on Heroku's ephemeral filesystem don't
// require re-scanning the QR code.
async function initializeWhatsAppClient() {
  if (isShuttingDown) return;
  if (isInitializingWhatsApp) {
    console.log('WhatsApp client initialization already in progress, skipping.');
    return;
  }
  isInitializingWhatsApp = true;
  isWhatsAppReady = false;
  shownQrThisClient = false;

  try {
    if (!whatsappStore) {
      whatsappStore = new WhatsAppMongoStore({ mongoose, dataPath: WHATSAPP_DATA_PATH });
    }

    client = new Client({
      authStrategy: new SafeRemoteAuth({
        store: whatsappStore,
        dataPath: WHATSAPP_DATA_PATH,
        // Effectively disables the library's periodic backups: they copy the
        // profile while Chrome runs and can overwrite a good backup with a
        // half-written one. Backups happen cleanly after a QR link and on
        // shutdown instead.
        backupSyncIntervalMs: 7 * 24 * 60 * 60 * 1000,
      }),
      // A restarting/overlapping dyno reuses the same session; take it over
      // instead of treating the conflict as a disconnect.
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
      puppeteer: {
        executablePath: process.env.NODE_ENV === 'production'
          ? '/app/.chrome-for-testing/chrome-linux64/chrome' // Heroku Linux production path
          : path.join(os.homedir(), '.cache', 'puppeteer', 'chrome', 'win64-148.0.7778.97', 'chrome-win64', 'chrome.exe'), // local Windows path
        defaultViewport: { width: 800, height: 600 },
        args: [
          // Run browser, renderer, GPU and utility work in one process instead
          // of 5-8, removing per-process overhead (biggest single saving).
          "--single-process",
          "--no-zygote",
          "--renderer-process-limit=1",
          "--disable-site-isolation-trials",
          // Chrome's reduced-memory mode (smaller caches, lower-res buffers).
          "--enable-low-end-device-mode",
          // Don't download/decode images (profile pics, thumbnails). Sending
          // images still works — that goes through upload, not rendering.
          "--blink-settings=imagesEnabled=false",
          // Chrome only honours the LAST --disable-features flag, so keep one.
          "--disable-features=site-per-process,IsolateOrigins,TranslateUI,Translate,BackForwardCache,MediaRouter,OptimizationHints,AudioServiceOutOfProcess,AutofillServerCommunication,CertificateTransparencyComponentUpdater,PaintHolding,DialMediaRouteProvider",
          "--js-flags=--max-old-space-size=256 --optimize-for-size",
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--disable-accelerated-2d-canvas",
          "--disable-dev-shm-usage",
          "--disable-cache",
          "--disk-cache-size=1",
          "--media-cache-size=1",
          "--aggressive-cache-discard",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-domain-reliability",
          "--disable-sync",
          "--metrics-recording-only",
          "--no-pings",
          "--mute-audio",
          "--disable-extensions",
          "--disable-component-extensions-with-background-pages",
          "--disable-breakpad",
          "--disable-crash-reporter",
          "--disable-hang-monitor",
          "--disable-notifications",
          "--disable-popup-blocking",
          "--disable-print-preview",
          "--disable-prompt-on-repost",
          // Keep WhatsApp's timers running at full speed in a headless tab.
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-ipc-flooding-protection",
          "--ignore-certificate-errors",
          "--log-level=3",
          "--no-default-browser-check",
          "--no-first-run",
          "--no-sandbox",
          "--disable-setuid-sandbox",
        ],
      }
    });

    client.on('qr', (qr) => {
      if (!shownQrThisClient) {
        console.log('No usable saved WhatsApp session — QR scan required.');
      }
      shownQrThisClient = true;
      console.log('Scan the QR code below to connect WhatsApp:');
      qrCodeData = qr;
      qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
      qrCodeData = null;
      isWhatsAppReady = true;
      isInitializingWhatsApp = false;
      loggedInThisRun = true;

      if (shownQrThisClient) {
        console.log('WhatsApp client is ready (new QR link). Clean backup in 90s.');
        // Let the post-link history sync settle first.
        setTimeout(cleanBackupAndReconnect, 90000);
      } else {
        console.log('WhatsApp client is ready — restored from saved session, no QR needed.');
      }
    });

    client.on('change_state', (state) => {
      console.log('WhatsApp state:', state);
    });

    client.on('loading_screen', (percent, message) => {
      console.log('LOADING SCREEN', percent, message);
    });

    client.on('authenticated', () => {
      console.log('WhatsApp authenticated');
    });

    client.on('remote_session_saved', () => {
      console.log('Remote session saved');
    });

    client.on('auth_failure', async (msg) => {
      console.error('AUTHENTICATION FAILURE', msg);
      isWhatsAppReady = false;
      isInitializingWhatsApp = false;
      loggedInThisRun = false;
      // Session is unusable — wipe it so the next attempt starts fresh with a new QR
      try {
        if (await whatsappStore.sessionExists({ session: 'RemoteAuth' })) {
          await whatsappStore.delete({ session: 'RemoteAuth' });
        }
      } catch (err) {
        console.error('Failed to delete broken session:', err);
      }
      setTimeout(initializeWhatsAppClient, 5000);
    });

    client.on('disconnected', async (reason) => {
      console.log('WhatsApp client disconnected:', reason);
      isWhatsAppReady = false;
      isInitializingWhatsApp = false;
      if (reason === 'LOGOUT') loggedInThisRun = false;
      if (isShuttingDown || isBackupRestart) return;

      try {
        // Only wipe the stored session on an explicit logout; a network drop
        // or Heroku restart should just reconnect with the existing session.
        if (reason === 'LOGOUT' && await whatsappStore.sessionExists({ session: 'RemoteAuth' })) {
          console.log('Logged out — deleting session from store');
          await whatsappStore.delete({ session: 'RemoteAuth' });
        }
      } catch (err) {
        console.error('Error while handling disconnect:', err);
      }

      try {
        await client.destroy();
      } catch (err) {
        // Client may already be torn down; ignore.
      }

      setTimeout(initializeWhatsAppClient, 5000);
    });

    await client.initialize();
  } catch (error) {
    console.error('Failed to initialize WhatsApp client:', error);
    isInitializingWhatsApp = false;
    setTimeout(initializeWhatsAppClient, 10000);
  }
}

db.once("open", () => {
  console.log('MongoDB connected');
  initializeWhatsAppClient();
});

// Heroku sends SIGTERM (then SIGKILL 30s later) on restarts/deploys; nodemon
// sends SIGUSR2; Ctrl+C sends SIGINT. Close Chrome *first* so it flushes its
// IndexedDB/Local Storage to disk, then back up that consistent profile —
// this is the backup the next boot restores from.
async function shutdownWhatsAppClient(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  console.log(`${signal} received, shutting down gracefully...`);

  // Not isWhatsAppReady: Heroku SIGTERMs Chrome at the same moment, and its
  // disconnect can flip that flag before we get here.
  if (client && loggedInThisRun) {
    await closeChromeCleanly(client);
    console.log(`Chrome closed after ${elapsed()}, backing up session...`);
    if (await client.authStrategy.storeRemoteSession({ emit: true }, 2)) {
      console.log(`Final WhatsApp session backup saved to MongoDB after ${elapsed()}.`);
    }
  } else if (client) {
    await closeChromeCleanly(client);
    console.log('WhatsApp was not logged in; skipping session backup.');
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdownWhatsAppClient('SIGTERM'));
process.on('SIGINT', () => shutdownWhatsAppClient('SIGINT'));
process.on('SIGUSR2', () => shutdownWhatsAppClient('SIGUSR2'));

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
app.use('/api', marketing);

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
      await sendMessage(client, validatePhoneNumber(phoneNumber), message);
      return res.status(200).json({ success: true, message: 'Message sent successfully' });

    // const target = await client.getContactById(validatePhoneNumber(phoneNumber));
    // if (target) {
    //   await client.sendMessage(target.id._serialized, message);
    //   return res.status(200).json({ success: true, message: 'Message sent successfully' });
    // } else {
    //   return res.status(400).json({ success: false, message: 'Contact not found' });
    // }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'whatsup-auth-not-found' });
  }
});

app.post('/api/sendWhatsupImages', async (req, res) => {
  const { imgUrls, phoneNumber } = req.body
  try {
      if (imgUrls && imgUrls.length > 0) {
        for (const imgUrl of imgUrls) {
          await sendPhoto(client, validatePhoneNumber(phoneNumber), imgUrl);
        }
      }

    // const target = await client.getContactById(validatePhoneNumber(phoneNumber));
    // if (target) {
    //   if (imgUrls && imgUrls.length > 0) {
    //     for (const imgUrl of imgUrls) {

    //       // const media = new MessageMedia('image/png', await imageToBase64(imgUrl))
    //       // await client.sendMessage(target.id._serialized, media);
    //     }
    //   }
    //   return res.status(200).json({ success: true, message: 'Images sent successfully' });
    // } else {
    //   return res.status(400).json({ success: false, message: 'Contact not found' });
    // }
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
        const rtlContent = `\u202B${user.message}`;
        await sendMessageQueue.add('send-message', { index: index + 1, content: rtlContent, phone: user.phoneNumber }, { delay: index * 10000 });
        index++;

        // const target = await client.getContactById(validatePhoneNumber(`${user.phoneNumber}@s.whatsapp.net`));
        // if (target) {
        //   const rtlContent = `\u202B${user.message}`;
        //   await sendMessageQueue.add('send-message', { target, index: index + 1, content: rtlContent }, { delay: index * 10000 });
        //   index++;
        // }
      }
    }
    return res.status(200).json({ success: true, message: 'Messages sent successfully' });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
})

app.post('/api/sendMessagesToClients', protect, isAdmin, async (req, res) => {
  const { imgUrl, content, target, testMode, testBigData, skip, limit } = req.body;

  try {
    // 1. Handle Test Mode (Single Message)
    if (testMode) {
      const generatedContent = replaceWords(content, {
        fullName: `Emad Khatrush`,
        customerId: 'A200',
        phone: '+905535728209',
      });
      const rtlContent = `\u202B${generatedContent}`;
      await sendMessageQueue.add('send-message', { index: 1, imgUrl, content: rtlContent, phone: `5535728209` });
      return res.status(200).json({ success: true, message: 'Test message queued' });

      // const contact = await client.getContactById(validatePhoneNumber(`5535728209`));
      // if (contact) {
      //   const generatedContent = replaceWords(content, {
      //     fullName: `Emad Khatrush`,
      //     customerId: 'A200',
      //     phone: '+905535728209',
      //   });
      //   const rtlContent = `\u202B${generatedContent}`;
      //   await sendMessageQueue.add('send-message', { target: contact, index: 1, imgUrl, content: rtlContent });
      //   return res.status(200).json({ success: true, message: 'Test message queued' });
      // }
    }

    // 2. Fetch Users
    let users;
    if (target === 'onlyNewClients') {
      users = await Users.aggregate([
        { $match: { 'roles.isClient': true, isCanceled: false } },
        { $lookup: { from: 'orders', localField: '_id', foreignField: 'user', as: 'orders' } },
        { $match: { orders: { $size: 0 } } },
        { $project: { phone: 1, firstName: 1, lastName: 1, customerId: 1 } },
        { $sort: { createdAt: -1 } },
        { $skip: Number(skip) || 0 },
        { $limit: Number(limit) || 5000 }
      ]);
    } else {
      users = await Users.find({ isCanceled: false, 'roles.isClient': true })
        .select({ phone: 1, firstName: 1, lastName: 1, customerId: 1 })
        .sort({ createdAt: -1 })
        .skip(Number(skip) || 0)
        .limit(Number(limit) || 5000);
    }

    const rtlContent = `\u202B${content}`;

    // 3. Handle Big Data Test (100 users)
    if (testBigData) {
      const usersTest = [];
      for (let i = 0; i < 100; i++) {
        usersTest.push({ phone: `111011111${i}@c.us`, firstName: 'Test', lastName: i });
      }
      // Send to the worker we modified earlier
      await sendMessageQueue.add('send-large-messages', { imgUrl, content: rtlContent, users: usersTest });
      return res.status(200).json({ success: true, message: 'Big data test started' });
    }

    // 4. Hand the list to the worker, which schedules 1 message per minute
    if (users.length > 0) {
      await sendMessageQueue.add('send-large-messages', {
        imgUrl,
        content: rtlContent,
        users
      }, {
        removeOnComplete: true
      });
    }

    return res.status(200).json({
      success: true,
      message: `Scheduling ${users.length} messages at 1 per minute (~${users.length} minutes, after any batch already queued)...`
    });

  } catch (error) {
    console.error("Route Error:", error);
    return res.status(500).json({ success: false, message: 'whatsup-auth-not-found' });
  }
});

sendMessageQueue.process('resume-jobs', 1, async (job) => {
  // Resume the queue
  await sendMessageQueue.resume();
  console.log('Queue resumed.');
})

const CLIENT_MESSAGE_INTERVAL_MS = 60 * 1000; // 1 message per minute
// Timestamp of the next free send slot, shared across campaigns so batches
// sent back-to-back (skip/limit) queue up behind each other instead of overlapping.
const CLIENT_NEXT_SLOT_KEY = 'whatsapp:clients:nextSlot';

// Schedules every message up front as a delayed job (persisted in Redis), so
// a Heroku restart mid-campaign doesn't lose the remaining messages.
sendMessageQueue.process('send-large-messages', 1, async (job) => {
  const { imgUrl, content, users } = job.data;

  const storedSlot = Number(await redisClient.get(CLIENT_NEXT_SLOT_KEY)) || 0;
  let nextSlot = Math.max(Date.now(), storedSlot);
  let index = 0;

  for (const user of users) {
    if (!user.phone || `${user.phone}`.length < 5) continue;

    const generatedContent = replaceWords(content, {
      fullName: `${user?.firstName} ${user?.lastName}`,
      customerId: user?.customerId,
      phone: user?.phone,
    });

    index++;
    await sendMessageQueue.add('send-message',
      { index, imgUrl, content: `\u202B${generatedContent}`, phone: `${user.phone}@c.us`, campaign: true },
      { delay: Math.max(0, nextSlot - Date.now()), removeOnComplete: true }
    );
    nextSlot += CLIENT_MESSAGE_INTERVAL_MS;
  }

  await redisClient.set(CLIENT_NEXT_SLOT_KEY, nextSlot);
  console.log(`Scheduled ${index} client messages, 1 per minute. Last one at ${new Date(nextSlot - CLIENT_MESSAGE_INTERVAL_MS).toISOString()}`);
});

// Claims the next free 1-per-minute slot and returns its delay from now.
async function claimNextClientSlot() {
  const storedSlot = Number(await redisClient.get(CLIENT_NEXT_SLOT_KEY)) || 0;
  const slot = Math.max(Date.now(), storedSlot);
  await redisClient.set(CLIENT_NEXT_SLOT_KEY, slot + CLIENT_MESSAGE_INTERVAL_MS);
  return slot - Date.now();
}

const MAX_MESSAGE_RETRIES = 3;

sendMessageQueue.process('send-message', 1, async (job) => {
  const { index, imgUrl, content, phone, campaign, retries = 0 } = job.data;

  try {
    if (imgUrl) {
      await sendPhoto(client, validatePhoneNumber(phone), imgUrl);
    }
    await sendMessage(client, validatePhoneNumber(phone), content);

    console.log("Message Sent " + index + ' !');
    await sendMessageQueue.clean(0);
  } catch (error) {
    // WhatsApp being disconnected isn't the message's fault \u2014 don't count it
    // against the retry limit, just wait for a later slot.
    const notConnected = error?.message === 'whatsup-auth-not-found';
    const nextRetries = notConnected ? retries : retries + 1;

    if (nextRetries > MAX_MESSAGE_RETRIES) {
      console.log(`Giving up on message ${index} to ${phone} after ${MAX_MESSAGE_RETRIES} retries: ${error?.message}`);
      return;
    }

    // Client campaign retries take the next free slot so they never break
    // the 1-per-minute rate; other messages keep a short fixed backoff.
    const delay = campaign ? await claimNextClientSlot() : 30000;
    console.log(`Error sending message ${index} (${error?.message}), retrying in ${Math.round(delay / 1000)}s`);
    await sendMessageQueue.add('send-message',
      { ...job.data, retries: nextRetries },
      { delay, removeOnComplete: true }
    );
  }
});

app.use(async (req, res) => {
  if (req.query.deleteMessages === 'all') {
    // 1. Forcefully wipe all jobs (active, waiting, delayed, failed) from Redis
    await sendMessageQueue.obliterate({ force: true });
    await redisClient.del(CLIENT_NEXT_SLOT_KEY);
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


/**
 * Sends a text message via the whatsapp-web.js client.
 * @param {Client} waClient
 * @param {string} jid - Target WhatsApp ID (phone_number@c.us)
 * @param {string} text - The message body
 */
async function sendMessage(waClient, jid, text) {
    if (!waClient || !isWhatsAppReady) {
        throw new Error('whatsup-auth-not-found');
    }
    try {
        await waClient.sendMessage(jid, text);
        console.log(`Message successfully sent to ${jid}`);
    } catch (error) {
        console.error('Failed to send message:', error);
        throw error;
    }
}

async function sendPhoto(waClient, jid, imgUrl) {
    if (!waClient || !isWhatsAppReady) {
        throw new Error('whatsup-auth-not-found');
    }
    try {
        const media = await MessageMedia.fromUrl(imgUrl, { unsafeMime: true });
        await waClient.sendMessage(jid, media);
        console.log(`Photo successfully sent to ${jid}`);
    } catch (error) {
        console.error('Failed to send photo:', error);
        throw error;
    }
}

// Error Handler
app.use(errorHandler);

const server = app.listen(process.env.PORT || 8000, () => {
  console.log(`Server working on http://localhost:${process.env.PORT || 8000}/`);
})
server.timeout = 600000;
