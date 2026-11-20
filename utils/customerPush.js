// Phone notifications to customers beyond the order stages (utils/orderPush.js): points earned, a
// new loyalty level, an announcement from the office, a shipment stopped or resumed.
//
// Each is called after its operation has committed, and never throws: a notification that can't
// go out never undoes or fails what the staff member did. Off without Firebase credentials, and on
// QA unless PUSH_ON_QA=1 (utils/push.js).
const { sendToUsers, sendToAll } = require('./push');

const pointsText = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
// An order number inside Arabic text, isolated left-to-right so "1853-5650" is not flipped
const ltr = (text) => `⁦${text}⁩`;
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
    body: `رقم الطلبية: ${ltr(order.orderId)}\n${reason ? `السبب: ${reason}\n` : ''}تواصل مع المكتب لمعرفة التفاصيل.`,
    url: `/order/${order._id}`,
    tag: `order-${order._id}`,
  }));
}

async function shippingResumed(order) {
  if (!order?.user) return { sent: 0 };
  return safely('shipping resumed', () => sendToUsers([order.user], {
    title: '✅ رجع شحن طلبيتك',
    body: `رقم الطلبية: ${ltr(order.orderId)}\nتُشحن الآن مع أقرب رحلة.`,
    url: `/order/${order._id}`,
    tag: `order-${order._id}`,
  }));
}

// A points offer that just started (spec 2026-11-19), to everyone: what it covers and its last day
const PROMO_COUNTRIES = { china: 'الصين', uae: 'الإمارات', turkey: 'تركيا', usa: 'أمريكا', uk: 'بريطانيا' };
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
// What an offer covers, and a Libya day as "الجمعة 27 نوفمبر"
function promotionWhat(p) {
  const parts = [];
  if ((p.kinds || []).includes('shipping')) {
    const methods = p.methods || [];
    const method = methods.length === 1 ? (methods[0] === 'air' ? ' الجوي' : ' البحري') : '';
    const countries = (p.countries || []).map((c) => PROMO_COUNTRIES[c] || c);
    parts.push(`الشحن${method}${countries.length ? ` من ${countries.join(' و')}` : ''}`);
  }
  if ((p.kinds || []).includes('purchase')) parts.push('فواتير الشراء');
  if ((p.kinds || []).includes('remittance')) parts.push('الحوالات');
  return parts.join(' و');
}
const libyaDay = (time) => {
  const day = require('moment-timezone').tz(time, 'Africa/Tripoli');
  return `${DAYS[day.day()]} ${day.date()} ${MONTHS[day.month()]}`;
};
const timesOf = (p) => Number(((p.multiplierPct || 100) / 100).toFixed(2));
// The last day the offer covers, in Libya (endsAt is the midnight after it)
const lastDayOf = (p) => libyaDay(new Date(p.endsAt).getTime() - 1);

function promotionText(p) {
  return {
    title: `🔥 ${p.name}: نقاطك ×${timesOf(p)}`,
    body: `على ${promotionWhat(p)} لكل طلبية تُنشئها حتى ${lastDayOf(p)}.`,
  };
}
// Announced before it starts: what is coming and from when
function promotionAnnouncedText(p) {
  return {
    title: `⏳ قريباً: ${p.name}، نقاطك ×${timesOf(p)}`,
    body: `على ${promotionWhat(p)} لكل طلبية تُنشئها من ${libyaDay(new Date(p.startsAt))} حتى ${lastDayOf(p)}.`,
  };
}
// Orders received and not rated yet: rate them all at once for 2 points each
const ordersCount = (n) => (n === 1 ? 'طلبية' : n === 2 ? 'طلبيتين' : n <= 10 ? `${n} طلبيات` : `${n} طلبية`);
const pointsPhrase = (n) => (n === 2 ? 'نقطتين' : `${n} ${n >= 3 && n <= 10 ? 'نقاط' : 'نقطة'}`);
function ratingReminderText(count) {
  const points = count * require('../accounting/services/loyalty/ratings').POINTS_EACH;
  return {
    title: `⭐ قيّم خدمتنا واكسب ${pointsPhrase(points)}`,
    body: count === 1 ? 'استلمت طلبية. قيّمها في أقل من دقيقة.'
      : `استلمت ${ordersCount(count)}. ${count === 2 ? 'قيّمهما' : 'قيّمها'} مرة واحدة في أقل من دقيقة.`,
  };
}
async function ratingReminder(userId, count) {
  return safely('rating', () => sendToUsers([userId], { ...ratingReminderText(count), url: '/rate', tag: 'rating' }));
}

// Invite a friend (spec 2026-11-20). A friend signed up with the customer's code
function referralJoinedText(friendName) {
  const { FIRST_POINTS, QUALIFY_USD } = require('../accounting/services/loyalty/referrals');
  return {
    title: `🎉 ${friendName} سجّل بدعوتك`,
    body: `عندما يصل مجموع ما يدفعه ${QUALIFY_USD}$ تكسب ${pointsText(FIRST_POINTS)} نقطة، ثم تكسب من كل شحنة له لمدة سنة.`,
  };
}
async function referralJoined(inviterId, friendName) {
  return safely('referral', () => sendToUsers([inviterId], { ...referralJoinedText(friendName), url: '/invite', tag: 'referral' }));
}
// The new customer's welcome gift
function referralWelcomeText(inviterName, points) {
  return {
    title: `🎁 هدية ${pointsText(points)} نقطة من ${inviterName}`,
    body: `أضفناها لرصيدك (${usdText(points)}). استعملها في أول فاتورة شحن أو شراء.`,
  };
}
async function referralWelcome(friendId, inviterName, points) {
  if (!(points > 0)) return { sent: 0 };
  return safely('referral', () => sendToUsers([friendId], { ...referralWelcomeText(inviterName, points), url: '/points', tag: 'referral' }));
}
// What an inviter got from their friends in one run: big rewards, steps, the share, together
function referralRewardsText({ firsts = [], share = 0, steps = [] } = {}) {
  const { FIRST_POINTS, QUALIFY_USD } = require('../accounting/services/loyalty/referrals');
  const total = firsts.length * FIRST_POINTS + share + steps.reduce((sum, s) => sum + s.points, 0);
  if (!(total > 0)) return null;
  const top = steps[steps.length - 1];
  if (top) {
    return {
      title: `🏆 ${top.friends} أصدقاء! كسبت ${pointsText(total)} نقطة`,
      body: top.ambassador
        ? `صرت «${top.title}»: من الآن تكسب ${require('../accounting/services/loyalty/referrals').AMBASSADOR_SHARE_POINTS} نقطة عن كل 50$ يدفعها أصدقاؤك.`
        : 'شكراً لأنك تنشر Exios. استمر وادعُ المزيد.',
    };
  }
  if (firsts.length) {
    const who = firsts.length === 1 ? `صديقك ${firsts[0]} وصل إلى ${QUALIFY_USD}$` : `${firsts.length} من أصدقائك وصلوا إلى ${QUALIFY_USD}$`;
    return { title: `💰 كسبت ${pointsText(total)} نقطة`, body: `${who}، وستكسب من كل شحنة لهم لمدة سنة.` };
  }
  return { title: `⭐ كسبت ${pointsText(total)} نقطة من شحن أصدقائك`, body: 'حصتك من شحنات من دعوتهم. ادعُ المزيد واكسب أكثر.' };
}
async function referralRewards(inviterId, got) {
  const text = referralRewardsText(got);
  if (!text) return { sent: 0 };
  const sent = await safely('referral', () => sendToUsers([inviterId], { ...text, url: '/invite', tag: 'referral' }));
  if (got.level) await levelUp(inviterId, got.level);
  return sent;
}

async function promotionAnnounced(p) {
  return safely('promotion', () => sendToAll({ ...promotionAnnouncedText(p), url: '/points', tag: 'promotion' }));
}
async function promotionStarted(p) {
  return safely('promotion', () => sendToAll({ ...promotionText(p), url: '/points', tag: 'promotion' }));
}

module.exports = { pointsEarned, levelUp, announcement, shippingBlocked, shippingResumed, promotionText, promotionStarted, promotionAnnouncedText, promotionAnnounced, ratingReminderText, ratingReminder,
  referralJoinedText, referralJoined, referralWelcomeText, referralWelcome, referralRewardsText, referralRewards };
