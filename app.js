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
const path = require('path');
const os = require('os');
const qrcode = require('qrcode-terminal');

process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || '/app/.cache/puppeteer';

// DB Collections
const Users = require('./models/user');
const Campaign = require('./models/campaign');

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
const popupAds = require('./routes/popupAds');
const analytics = require('./routes/analytics');
const campaigns = require('./routes/campaigns');
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

// Bull queue with Redis client - shared module so controllers (e.g. campaign
// delete, which cancels pending jobs) reference the same queue instance.
const sendMessageQueue = require('./utils/messageQueue');

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
// briefly close Chrome, snapshot the flushed profile locally (~1s), reconnect
// from that snapshot (~20s offline), and upload it to Mongo in the background
// — the upload takes minutes on this database, too long to wait for.
const SNAPSHOT_REFRESH_MS = 6 * 60 * 60 * 1000;
let snapshotRefreshTimer = null;

async function cleanBackupAndReconnect() {
  if (isShuttingDown || !isWhatsAppReady || !client) return;
  console.log('Taking clean WhatsApp session snapshot (reconnecting in a few seconds)...');
  isBackupRestart = true;
  isWhatsAppReady = false;
  const oldClient = client;
  let snapshotOk = false;
  try {
    await closeChromeCleanly(oldClient);
    snapshotOk = await oldClient.authStrategy.snapshotSession();
  } finally {
    isBackupRestart = false;
  }
  initializeWhatsAppClient();

  if (!snapshotOk) return;
  const started = Date.now();
  console.log('Uploading WhatsApp session snapshot to MongoDB in the background...');
  if (await oldClient.authStrategy.uploadSnapshot()) {
    console.log(`WhatsApp session backup saved to MongoDB (upload took ${((Date.now() - started) / 1000).toFixed(0)}s). Restarts will reconnect without a QR.`);
  }
}

// Keeps the MongoDB copy reasonably fresh, so a restart doesn't restore a
// session that is many days old.
function scheduleSnapshotRefresh() {
  clearTimeout(snapshotRefreshTimer);
  snapshotRefreshTimer = setTimeout(async () => {
    await cleanBackupAndReconnect();
    scheduleSnapshotRefresh();
  }, SNAPSHOT_REFRESH_MS);
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

      if (shownQrThisClient) {
        console.log('WhatsApp client is ready (new QR link). Clean snapshot in 90s.');
        // 'ready' can fire twice per login; one timer covers both. Waiting
        // lets the post-link history sync settle first.
        clearTimeout(snapshotRefreshTimer);
        snapshotRefreshTimer = setTimeout(async () => {
          await cleanBackupAndReconnect();
          scheduleSnapshotRefresh();
        }, 90000);
      } else {
        console.log('WhatsApp client is ready — restored from saved session, no QR needed.');
        scheduleSnapshotRefresh();
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
// sends SIGUSR2; Ctrl+C sends SIGINT. No backup here: uploading the session
// to this MongoDB takes ~3 minutes, far past Heroku's 30s, and a killed upload
// only leaves junk behind. The next boot restores the latest clean snapshot.
async function shutdownWhatsAppClient(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  clearTimeout(snapshotRefreshTimer);
  if (client) {
    await closeChromeCleanly(client);
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
app.use('/api', popupAds);
app.use('/api', analytics);
app.use('/api', campaigns);

app.get('/api/get-qr-code', (req, res) => {
  if (qrCodeData) {
    res.status(200).json({ qrCode: qrCodeData });
  } else {
    res.status(404).json({ message: 'QR code not available yet' });
  }
});

// Rejects WhatsApp requests up front when the client can't send, so the
// frontend shows an error instead of "sent" for messages that would only sit
// in the queue. 'whatsup-auth-not-found' is the code the admin frontend maps
// to "You need to scan QR"; the other message is shown to the user as-is.
function requireWhatsApp(req, res, next) {
  if (client && isWhatsAppReady) return next();
  const message = qrCodeData
    ? 'whatsup-auth-not-found'
    : 'WhatsApp is connecting, please try again in a few minutes.';
  return res.status(503).json({ success: false, message });
}

app.post('/api/sendWhatsupMessage', requireWhatsApp, async (req, res) => {
  const { phoneNumber, message } = req.body
  try {
    await sendMessage(client, validatePhoneNumber(phoneNumber), message);
    return res.status(200).json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    return res.status(500).json({ success: false, message: `Failed to send WhatsApp message: ${error.message}` });
  }
});

app.post('/api/sendWhatsupImages', requireWhatsApp, async (req, res) => {
  const { imgUrls, phoneNumber } = req.body
  try {
    for (const imgUrl of imgUrls || []) {
      await sendPhoto(client, validatePhoneNumber(phoneNumber), imgUrl);
    }
    return res.status(200).json({ success: true, message: 'Images sent successfully' });
  } catch (error) {
    return res.status(500).json({ success: false, message: `Failed to send WhatsApp image: ${error.message}` });
  }
});

app.post('/api/inventorySendWhatsupMessages', protect, requireWhatsApp, async (req, res) => {
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

app.post('/api/sendMessagesToClients', protect, isAdmin, requireWhatsApp, async (req, res) => {
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

    // 4. Persist a campaign record (snapshot of who is being targeted) so the
    // admin can track sent/failed progress and manage or delete it later.
    // Normalize each stored phone (a Number, so any leading 0 is lost) into a
    // WhatsApp ID up front, so the campaign and the worker use the exact
    // number that gets messaged. Users with no usable phone are left out so
    // the campaign total only counts people who will actually get a message.
    users = users
      .filter((user) => user.phone && `${user.phone}`.length >= 5)
      .map((user) => ({
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        customerId: user.customerId,
        rawPhone: `${user.phone}`,
        phone: validatePhoneNumber(user.phone),
      }));

    let campaign = null;
    if (users.length > 0) {
      campaign = await Campaign.create({
        content,
        imgUrl: imgUrl || null,
        target,
        totalUsers: users.length,
        createdBy: req.user._id,
        users: users.map((user) => ({
          user: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phone.split('@')[0],
          customerId: user.customerId,
          status: 'pending',
        })),
      });

      // 5. Hand the list to the worker, which schedules 1 message per minute
      await sendMessageQueue.add('send-large-messages', {
        imgUrl,
        content: rtlContent,
        users,
        campaignId: String(campaign._id),
      }, {
        removeOnComplete: true
      });
    }

    return res.status(200).json({
      success: true,
      campaignId: campaign?._id || null,
      message: `Scheduling ${users.length} messages at 1 per minute (~${users.length} minutes, after any batch already queued)...`
    });

  } catch (error) {
    console.error("Route Error:", error);
    return res.status(500).json({ success: false, message: error.message });
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
  const { imgUrl, content, users, campaignId } = job.data;

  const storedSlot = Number(await redisClient.get(CLIENT_NEXT_SLOT_KEY)) || 0;
  let nextSlot = Math.max(Date.now(), storedSlot);
  let index = 0;

  for (const user of users) {
    if (!user.phone || `${user.phone}`.length < 5) continue;

    const generatedContent = replaceWords(content, {
      fullName: `${user?.firstName} ${user?.lastName}`,
      customerId: user?.customerId,
      phone: user?.rawPhone || user?.phone,
    });

    index++;
    await sendMessageQueue.add('send-message',
      { index, imgUrl, content: `\u202B${generatedContent}`, phone: validatePhoneNumber(user.phone), campaign: true, campaignId, userId: user._id ? String(user._id) : undefined },
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

// Marks one targeted user's status on their campaign and bumps the counters,
// then flips the campaign to 'completed' once every user has a final status.
// Cancelled/deleted campaigns (userId no longer matched, or campaign gone)
// are silently ignored - the message either already went out or was skipped.
async function updateCampaignProgress(campaignId, userId, status) {
  if (!campaignId || !userId) return;
  try {
    const counterField = status === 'sent' ? 'sentCount' : 'failedCount';
    const campaign = await Campaign.findOneAndUpdate(
      { _id: campaignId, 'users.user': userId },
      {
        $set: { 'users.$.status': status, 'users.$.sentAt': new Date() },
        $inc: { [counterField]: 1 },
      },
      { new: true }
    );
    if (campaign && campaign.sentCount + campaign.failedCount >= campaign.totalUsers && campaign.status === 'sending') {
      campaign.status = 'completed';
      await campaign.save();
    }
  } catch (error) {
    console.error('Failed to update campaign progress:', error);
  }
}

sendMessageQueue.process('send-message', 1, async (job) => {
  const { index, imgUrl, content, phone, campaign, campaignId, userId, retries = 0 } = job.data;

  try {
    if (imgUrl) {
      await sendPhoto(client, validatePhoneNumber(phone), imgUrl);
    }
    await sendMessage(client, validatePhoneNumber(phone), content);

    console.log("Message Sent " + index + ' !');
    await sendMessageQueue.clean(0);
    await updateCampaignProgress(campaignId, userId, 'sent');
  } catch (error) {
    // WhatsApp being disconnected isn't the message's fault \u2014 don't count it
    // against the retry limit, just wait for a later slot.
    const notConnected = error?.message === 'whatsup-auth-not-found';
    const nextRetries = notConnected ? retries : retries + 1;

    if (nextRetries > MAX_MESSAGE_RETRIES) {
      console.log(`Giving up on message ${index} to ${phone} after ${MAX_MESSAGE_RETRIES} retries: ${error?.message}`);
      await updateCampaignProgress(campaignId, userId, 'failed');
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

// Identify the real image type from the file's first bytes, since URL
// extensions and Content-Type headers are often missing or wrong.
function detectImageMime(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
    if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

// Downloads the image ourselves instead of MessageMedia.fromUrl, which sends
// whatever the URL returns (error pages, empty bodies, unknown formats).
async function downloadImage(imgUrl) {
    const res = await fetch(imgUrl);
    if (!res.ok) {
        throw new Error(`Image download failed: HTTP ${res.status} for ${imgUrl}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mimetype = detectImageMime(buf);
    if (!mimetype) {
        throw new Error(`URL is not a JPEG/PNG/GIF/WEBP image (Content-Type: ${res.headers.get('content-type')}, ${buf.length} bytes): ${imgUrl}`);
    }
    return new MessageMedia(mimetype, buf.toString('base64'), `image.${mimetype.split('/')[1]}`, buf.length);
}

// whatsapp-web.js 1.34.7 bug (wwebjs/whatsapp-web.js#201921): the MediaData
// model carries a private __x_id that, when spread into the outgoing message,
// overwrites the message's own id, so every media send fails with "Data passed
// to getter must include an id property". Strip it in the page, the same fix as
// upstream PR #201923. Re-applied per send because the page can be re-injected.
// Remove once a whatsapp-web.js release includes that PR.
async function patchMediaIdCollision(waClient) {
    await waClient.pupPage.evaluate(() => {
        const wwebjs = window.WWebJS;
        if (!wwebjs || wwebjs.processMediaData.__xIdPatched) return;
        const original = wwebjs.processMediaData;
        const patched = async (...args) => {
            const mediaData = await original(...args);
            if (mediaData && Object.prototype.hasOwnProperty.call(mediaData, '__x_id')) {
                delete mediaData.__x_id;
            }
            return mediaData;
        };
        patched.__xIdPatched = true;
        wwebjs.processMediaData = patched;
    });
}

async function sendPhoto(waClient, jid, imgUrl) {
    if (!waClient || !isWhatsAppReady) {
        throw new Error('whatsup-auth-not-found');
    }
    let media;
    try {
        media = await downloadImage(imgUrl);
        await patchMediaIdCollision(waClient);
        await waClient.sendMessage(jid, media);
        console.log(`Photo successfully sent to ${jid}`);
    } catch (error) {
        const info = media ? `${media.mimetype}, ${media.filesize} bytes` : 'not downloaded';
        console.error(`Failed to send photo to ${jid} (${info}, url: ${imgUrl}):`, error.message);
        throw error;
    }
}

// Error Handler
app.use(errorHandler);

const server = app.listen(process.env.PORT || 8000, () => {
  console.log(`Server working on http://localhost:${process.env.PORT || 8000}/`);
})
server.timeout = 600000;
