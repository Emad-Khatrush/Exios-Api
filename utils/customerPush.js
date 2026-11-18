// Phone notifications to customers beyond the order stages (utils/orderPush.js): points earned, a
// new loyalty level, an announcement from the office, a shipment stopped or resumed.
//
// Each is called after its operation has committed, and never throws: a notification that can't
// go out never undoes or fails what the staff member did. Off without Firebase credentials, and on
// QA unless PUSH_ON_QA=1 (utils/push.js).
const { sendToUsers, sendToAll } = require('./push');

const pointsText = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const usdText = (points) => `${((Number(points) || 0) / 100).toFixed(2)} $`;

const safely = async (what, send) => {
  try {
    return await send();
  } catch (error) {
    console.error(`[push] ${what}:`, error.message);
    return { sent: 0, error: error.message };
  }
};

// Points earned by one customer in one run of the loyalty job (all their orders, added up)
async function pointsEarned(userId, points) {
  if (!(points > 0)) return { sent: 0 };
  return safely('points', async () => {
    const { summaryOf } = require('../accounting/services/loyalty');
    const balance = (await summaryOf(userId)).points;
    return sendToUsers([userId], {
      title: `⭐ كسبت ${pointsText(points)} نقطة`,
      body: `رصيدك الآن ${pointsText(balance)} نقطة (${usdText(balance)}). تقدر تستعملها في دفعتك القادمة.`,
      url: '/points',
      tag: 'points',
    });
  });
}

// A customer moved up to a higher level (reached by points, or raised by staff)
async function levelUp(userId, levelKey) {
  return safely('level', async () => {
    const tier = require('../accounting/services/loyalty/tiers').tierOf(levelKey);
    const gift = tier.upgradeGift > 0 ? `أضفنا لك هدية ${pointsText(tier.upgradeGift)} نقطة. ` : '';
    const more = tier.multiplierPct > 100 ? `ونقاطك صارت تزيد ${tier.multiplierPct - 100}% على كل طلبية.` : 'اكتشف مزايا مستواك.';
    return sendToUsers([userId], {
      title: `🏅 مبروك! صرت في المستوى ${tier.name}`,
      body: `${gift}${more}`,
      url: '/points',
      tag: 'level',
    });
  });
}

// A new announcement, to every device that turned notifications on
async function announcement(description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  if (!text) return { sent: 0 };
  return safely('announcement', () => sendToAll({
    title: '📢 إعلان من Exios',
    body: text.length > 180 ? `${text.slice(0, 177)}…` : text,
    url: '/home',
    tag: 'announcement',
  }));
}

// Staff stopped (or let go again) the shipping of an order
async function shippingBlocked(order, reason) {
  if (!order?.user) return { sent: 0 };
  return safely('shipping blocked', () => sendToUsers([order.user], {
    title: '⚠️ أوقفنا شحن طلبيتك',
    body: `رقم الطلبية: ${order.orderId}\n${reason ? `السبب: ${reason}\n` : ''}تواصل مع المكتب لمعرفة التفاصيل.`,
    url: `/order/${order._id}`,
    tag: `order-${order._id}`,
  }));
}

async function shippingResumed(order) {
  if (!order?.user) return { sent: 0 };
  return safely('shipping resumed', () => sendToUsers([order.user], {
    title: '✅ رجع شحن طلبيتك',
    body: `رقم الطلبية: ${order.orderId}\nتُشحن الآن مع أقرب رحلة.`,
    url: `/order/${order._id}`,
    tag: `order-${order._id}`,
  }));
}

module.exports = { pointsEarned, levelUp, announcement, shippingBlocked, shippingResumed };
