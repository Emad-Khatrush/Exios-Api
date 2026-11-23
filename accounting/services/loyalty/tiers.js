// Loyalty levels (owner's request 2026-11-17). Every rule of the levels lives here: names, the points
// that reach each level, the earning multiplier, how long earned points last, the upgrade gift and the perks
// shown to customers and staff. Change a level here and both apps follow (they read GET .../tiers).
//
// A customer's level comes from their "level points": the points they EARNED from paid orders in the
// last 365 days (before any multiplier; gifts and staff additions never count). Spending points never
// lowers the level. A level reached is kept for a year. At the yearly review the level is kept when the
// level points reach 70% of what the level needs (KEEP_SHARE); else it drops one level at most.
// Only orders from LOYALTY_START_DATE on count: nothing from before is carried over.

const REVIEW_DAYS = 365;
// At the yearly review a level is kept with this share of its points (owner's rule 2026-11-18)
const KEEP_SHARE = 0.7;
// The level points count what was earned within this window
const WINDOW_DAYS = 365;
// The app warns the customer this many days before the review when they would drop
const WARN_DAYS = 30;
// "Close to the next level" for the staff report: what is left is at most this share of the gap
const NEAR_SHARE = 0.2;

// From the lowest level up: برونزي, فضي, ذهبي, بلاتيني, ماسي (owner's choice 2026-11-18). Everyone
// starts at برونزي. `min`: level points to reach it (1 level point per $2 of shipping or purchase).
// `multiplierPct`: earned points are multiplied by it (110 = ×1.1). `expiryDays`: how long points
// earned at this level last. `upgradeGift`: points given once, the first time ever the customer
// reaches the level.
const TIERS = [
  {
    key: 'bronze', name: 'برونزي', nameEn: 'Bronze', color: '#a0522d',
    min: 0, multiplierPct: 100, expiryDays: 365, upgradeGift: 0,
    perks: ['تكسب 10 نقاط عن كل 20$ شحن أو شراء', 'نقاطك صالحة 12 شهراً'],
  },
  {
    key: 'silver', name: 'فضي', nameEn: 'Silver', color: '#64748b',
    min: 1000, multiplierPct: 110, expiryDays: 365, upgradeGift: 300,
    perks: ['نقاط أكثر بـ 10% على كل طلبية', 'هدية 300 نقطة عند الترقية'],
  },
  {
    key: 'gold', name: 'ذهبي', nameEn: 'Gold', color: '#b7791f',
    min: 5000, multiplierPct: 125, expiryDays: 548, upgradeGift: 500,
    perks: ['نقاط أكثر بـ 25% على كل طلبية', 'هدية 500 نقطة عند الترقية', 'نقاطك صالحة 18 شهراً', 'تجميع الطرود مجاناً', 'أولوية في الاستلام والرد'],
  },
  {
    key: 'platinum', name: 'بلاتيني', nameEn: 'Platinum', color: '#334155',
    min: 15000, multiplierPct: 150, expiryDays: 730, upgradeGift: 1000,
    perks: ['نقاط أكثر بـ 50% على كل طلبية', 'هدية 1,000 نقطة عند الترقية', 'نقاطك صالحة 24 شهراً', 'سعر شحن خاص', 'قروب واتساب مخصص لك', 'تجميع الطرود مجاناً', '30 يوم تخزين إضافي مجاناً', 'أولوية في الاستلام والرد'],
  },
  {
    key: 'diamond', name: 'ماسي', nameEn: 'Diamond', color: '#2563eb',
    min: 30000, multiplierPct: 175, expiryDays: 730, upgradeGift: 2000,
    perks: ['نقاط أكثر بـ 75% على كل طلبية', 'هدية 2,000 نقطة عند الترقية', 'نقاطك صالحة 24 شهراً', 'أفضل سعر شحن', 'موظف مخصص لك على واتساب', 'تجميع الطرود مجاناً', '30 يوم تخزين إضافي مجاناً', 'أولوية قصوى في الاستلام والرد'],
  },
];

const BASE = TIERS[0];
const byKey = new Map(TIERS.map((tier, rank) => [tier.key, { ...tier, rank }]));

// A level by its key, with its rank (0 = the first); an unknown key is the first level
const tierOf = (key) => byKey.get(key) || { ...BASE, rank: 0 };
const rankOf = (key) => tierOf(key).rank;

// The highest level the level points reach
function qualifyingTier(points) {
  let found = { ...BASE, rank: 0 };
  TIERS.forEach((tier, rank) => { if ((Number(points) || 0) >= tier.min) found = { ...tier, rank }; });
  return found;
}

// The next level up, or null at the top
const nextTier = (key) => {
  const rank = rankOf(key);
  return rank + 1 < TIERS.length ? { ...TIERS[rank + 1], rank: rank + 1 } : null;
};

// The points a claim earns at a level: whole points, rounded down
const multiplied = (points, key) => Math.floor(((Number(points) || 0) * tierOf(key).multiplierPct) / 100);

// The level points that keep a level at the yearly review: 70% of what it needs, rounded up
const keepMin = (key) => Math.ceil(tierOf(key).min * KEEP_SHARE);

// What the apps show of each level (no internal fields)
const publicTiers = () => TIERS.map((tier, rank) => ({
  key: tier.key, name: tier.name, nameEn: tier.nameEn, color: tier.color, rank, min: tier.min,
  multiplier: tier.multiplierPct / 100, expiryMonths: Math.round(tier.expiryDays / 30.4),
  keepMin: Math.ceil(tier.min * KEEP_SHARE), upgradeGift: tier.upgradeGift, perks: tier.perks,
}));

module.exports = { TIERS, REVIEW_DAYS, KEEP_SHARE, keepMin, WINDOW_DAYS, WARN_DAYS, NEAR_SHARE, tierOf, rankOf, qualifyingTier, nextTier, multiplied, publicTiers };
