if (process.env.NODE_ENV !== "production") {
  require('dotenv').config();
}
const express = require('express');
const mongoose = require('mongoose');
const morgan = require('morgan');
const cors = require('cors');
const bodyParser = require('body-parser');
const errorHandler = require('./middleware/error');
const { generatePDF } = require("./utils/sender");
const { validatePhoneNumber, imageToBase64 } = require('./utils/messages');
const Queue = require('bull');

// DB Collections
const Users = require('./models/user');
const order = require('./models/order');

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

// Whatsup packages
const { Client, RemoteAuth, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const user = require('./models/user');

let qrCodeData = null;
let client;

let REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const app = express();
const sendMessageQueue = new Queue('send-message', REDIS_URL, {
  limiter: {
    max: 1, // Number of concurrent jobs processed by queue
    duration: 1000, // Time in ms to check for jobs to process
  },
  attempts: 3, // Number of times to retry a job after it fails
}); 

const connectionUrl = process.env.MONGO_URL || 'mongodb://localhost:27017/exios-admin'
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

const db = mongoose.connection;
db.on("error", console.error.bind(console, "connection error:"));
db.once("open", () => {
  console.log('MongoDB connected');
  const store = new MongoStore({ mongoose: mongoose });
  const WhatsAppConfig = process.env.NODE_ENV !== "production" ? LocalAuth : RemoteAuth;
  client = new Client({
    authStrategy: new WhatsAppConfig({
      clientId: 'admin-client',
      store,
      backupSyncIntervalMs: 300000
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox']
    },
  });
  client.initialize();

  client.on('qr', (qr) => {
    console.log(qr);
    qrCodeData = qr;
    qrcode.generate(qr, { small: true });
  })

  client.on('ready', () => {
    console.log('WhatsApp client is ready!');
  });
  
  client.on('authenticated', (session) => {    
    // Save the session object however you prefer.
    // Convert it to json, save it to a file, store it in a database...
    console.log("authenticated");
  });
  
  client.on('remote_session_saved', () => {
    console.log('Remote Session Saved');
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

app.use(async (req, res) => {
  if (req.query.send === 'sendAll') {
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
    //   {
    //     $match: {
    //       orders: { $size: 0 }
    //     }
    //   },
    //   {
    //     $sort: {
    //       createdAt: -1
    //     }
    //   }
    // ])
    const users = await Users.find({ isCanceled: false }).sort({ createdAt: -1 });
    users.forEach(async (user, index) => {
      try {
        if (user.phone && `${user.phone}`.length >= 5) {
          const target = await client.getContactById(validatePhoneNumber(`${user.phone}@c.us`));
          if (target) {
            await sendMessageQueue.add('send-message', { target, user, index: index + 1 }, { delay: index * 10000 });
          }
        }
      } catch (error) {
        console.error(error);
      }
    })
  // generatePDF(newClients).catch((error) => {
  //   console.error(error);
  // });
  // res.send(newClients);
  }

  res.status(404).send("Page Not Found");
});

sendMessageQueue.process('resume-jobs', 1, async (job) => {
  // Resume the queue
  await sendMessageQueue.resume();
  console.log('Queue resumed.');
})

let jobCounter = 0;

sendMessageQueue.process('send-message', 1, async (job) => {
  const { target, index, user } = job.data;

  try {
    const media = new MessageMedia('image/png', await imageToBase64('https://storage.googleapis.com/exios-bucket/final-1.jpg'))
    await client.sendMessage(target.id._serialized, media);
    await client.sendMessage(target.id._serialized, `
سعياً منا لتقديم الأفضل دائما والتقدم و تسهيل كافة إجراءات الشحن واختصار للكثير من الوقت .
نعلن لكافة عملائنا الأعزاء عن افتتاح مخزننا الجديد فى مدينة فوشان بالصين 🇨🇳
سيقدم المخزن الجديد خدمات ومنها: 
1- الشحن الجوي والشحن البحري المشترك وحاويات.
2- تصوير البضائع التي وصلت وتحميل صورها على منظومتنا.
3- خدمة تفتيش البضائع والتقاط صور البضائع في الداخل.
4- معرفة وزن او حجم الشحنه فور وصولها الى المخزن.
5- متابعة الشحنة الى ان تصل الى ليبيا وتكون جاهزه للاستلام.

عنوان مخزن الجديد
Exios Foshan Warehouse
广东省佛山市南海区里水镇科顺路6号 威微物流（Exios仓)  周映 18711284724
*لا تنس وضع طريقة الشحن وكودك في العنوان*

اسعار الشحن الان
الشحن الجوي: 10 دولار للكيلو
الشحن البحري: 170 دولار للمتر المكعب الواحد
    
حيث تم تحديث العنوان الجديد على موقعنا الاكتروني، فعلى الراغبين بالشحن عن طريقنا زيارة الموقع وفتح كود وذهاب لقسم 'ابدأ الشحن' من خلاله تبع الخطوات وارسل بضائعك الى مخزننا.
    
للاستفسار على الارقام التالية:
مكتب طرابلس 0915643265 هاتف وواتس اب
موقع فرع طرابلس عبر خرائط قوقل:
https://maps.app.goo.gl/bNLewHNv1edSZnmE9

مكتب بنغازي 0919734019 هاتف وواتس اب
موقع فرع بنغازي عبر خرائط قوقل:
https://maps.app.goo.gl/h6bafxYrm5edNXL97

مواعيد الدوام: من ساعة 11 صباحا الى 5 مساءا

https://www.exioslibya.com/login
شركة اكسيوس للشراء والشحن
تحياتي لكم
    `);
    console.log("Message Sent " + index + ' !');

  } catch (error) {
    console.log(`Error processing job, attempt ${index}: ${error?.message}`);
    // Retry the job after a delay of 10 seconds
    await sendMessageQueue.add('send-message', { target, user, index }, { delay: index * 30000 });
    return Promise.resolve();
  }

  // Introduce a delay of 3 seconds before processing the next job
  await job.delay(5000);

  return Promise.resolve();
});

// Error Handler
app.use(errorHandler);

const server = app.listen(process.env.PORT || 8000, () => {
  console.log(`Server working on http://localhost:${process.env.PORT || 8000}/`);
})
server.timeout = 300000;
