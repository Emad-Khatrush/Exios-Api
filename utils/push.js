// Push notifications to the client app through Firebase Cloud Messaging.
//
// Needs the service account of the Firebase project the client app uses ("exios-client"):
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY (\n escaped, like GOOGLE_SECRET_KEY)
// Without them nothing is sent and nothing fails: the callers carry on as before.
// QA sends only when PUSH_ON_QA=1 as well: its tokens are the testers' own devices (they turned
// notifications on in the QA client app), never real customers'.
const PushToken = require('../models/pushToken');
const { isQa } = require('./qaEnvironment');

let messaging; // undefined: not tried yet, null: push is off
const getMessaging = () => {
  if (messaging !== undefined) return messaging;
  const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: key } = process.env;
  if (isQa && process.env.PUSH_ON_QA !== '1') {
    messaging = null;
    return messaging;
  }
  if (!projectId || !clientEmail || !key) {
    messaging = null;
    console.log('[push] off: FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY are not set');
    return messaging;
  }
  try {
    const admin = require('firebase-admin');
    const app = admin.apps.find((a) => a?.name === 'push')
      || admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey: key.replace(/\\n/g, '\n') }) }, 'push');
    messaging = app.messaging();
  } catch (error) {
    console.error('[push] could not start:', error.message);
    messaging = null;
  }
  return messaging;
};

const isPushOn = () => !!getMessaging();

// Tokens Firebase says are gone for good (app uninstalled, notifications turned off, logged out)
const DEAD = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'];

/**
 * Sends one notification to every device of these customers. Never throws.
 * @param {Array} userIds
 * @param {{ title: string, body: string, url?: string, tag?: string }} message
 *   url: the page of the client app the tap opens; tag: a newer notification with the same tag
 *   replaces the older one on the phone instead of stacking.
 */
async function sendToUsers(userIds, message) {
  if (!getMessaging() || !userIds?.length) return { sent: 0 };
  return sendTo({ user: { $in: userIds } }, message);
}

// Every device that turned notifications on (an announcement from the office). Never throws.
async function sendToAll(message) {
  if (!getMessaging()) return { sent: 0 };
  return sendTo({}, message);
}

async function sendTo(filter, { title, body, url = '/home', tag = '' }) {
  const fcm = getMessaging();
  try {
    const rows = await PushToken.find(filter).select('token').lean();
    const tokens = [...new Set(rows.map((r) => r.token))];
    if (!tokens.length) return { sent: 0 };

    let sent = 0;
    const dead = [];
    // FCM takes up to 500 tokens per call
    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      // Data only: the app's service worker (sw.js) shows it, the same way on every browser
      const res = await fcm.sendEachForMulticast({
        tokens: batch,
        data: { title, body, url, tag },
        webpush: { headers: { Urgency: 'high', TTL: String(3 * 24 * 60 * 60) } },
      });
      sent += res.successCount;
      res.responses.forEach((r, j) => { if (!r.success && DEAD.includes(r.error?.code)) dead.push(batch[j]); });
    }
    if (dead.length) await PushToken.deleteMany({ token: { $in: dead } });
    return { sent, removed: dead.length };
  } catch (error) {
    console.error('[push] send failed:', error.message);
    return { sent: 0, error: error.message };
  }
}

module.exports = { sendToUsers, sendToAll, isPushOn };
