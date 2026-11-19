# Rating rewards (مكافأة تقييم الخدمة)

Date: 2026-11-19. Builds on the loyalty points (`2026-11-16-loyalty-points-design.md`).

## Goal

Customers rate the service more often: every order rated within 30 days of receiving it earns **2 points**, and one rating covers every order they received and have not rated yet, so a customer with 10 shipments rates once and earns 20 points. It is easy to find: a card on the home page and a reminder notification.

## Decisions (owner, 2026-11-19)

1. **2 points per order rated** (first 5, then 3, then 2: owner, 2026-11-19). Only orders created from the programme's start (`LOYALTY_START_DATE`) are offered, earn or are reminded; older ones can still be rated on the order page, without points.
2. **One rating covers every received, unrated order** (shipping and purchase together); the customer can untick any.
3. **A purchase invoice is delivered at «تم الشراء»** (`orderStatus >= 1`); a shipment once a package was handed over.
4. **30 days** from delivery to earn the points.

## When an order awaits rating

All of: the customer's own; not cancelled; created on or after `LOYALTY_START_DATE`; no `OrderRating` for it; and delivered:
- shipment (`isShipment` or not a purchase invoice): at least one package `status.received`, or `isFinished`. Delivered at the latest `paymentList.deliveredPackages.deliveredInfo.deliveredDate` of its received packages, else `updatedAt`.
- purchase invoice (`isPayment && !isShipment`): `orderStatus >= 1`. Delivered at `updatedAt` (no field records the moment it was bought; the last change is usually that one).
- and `deliveredAt >= now − 30 days`.

## Points

2 per order, as a loyalty `add` movement through `grantGift` with `eventKey: RATING:<orderId>` (so never twice), reason «مكافأة تقييم الخدمة», one movement per order. Like every gift they do not count towards the level. A customer whose points are off: the rating is saved, no points.

## API

- `GET client/ratings/pending` → `{ orders: [{ _id, orderId, kind: 'shipping'|'purchase'|'remittance', trackingNumbers, deliveredAt }], pointsEach: 3, days: 30, off }` (newest first, up to 50).
- `POST client/ratings` `{ orderIds: string[], questions }` → saves one `OrderRating` per order that awaits rating (others are skipped: not theirs, already rated, too old, not delivered), grants 2 points each, returns `{ rated, points }`. 400 when none qualifies or the questions are missing.
- `POST client/order/:id/rating` (the order page) goes through the same service with one order; it now also refuses an order that is not the customer's (it did not check before).

## Reminder

In the hourly loyalty jobs (`runLoyaltyJobs`, `ratings` job): orders that await rating and have no `ratingRemindedAt`, grouped by customer: `ratingRemindedAt = now` on them (claimed atomically per order), then one push per customer: title «⭐ قيّم خدمتنا واكسب ${n×2} نقطة», body «استلمت ${n} طلبيات. قيّمها مرة واحدة في أقل من دقيقة.» (singular/dual wording), url `/rate`. New field on Order: `ratingRemindedAt: Date`.

## Client app

- `/rate` page (signed in): the orders awaiting rating as ticked cards (order number, kind, tracking numbers), the two star questions and the text the order page already asks (`employeeQuestion`, `generalQuestion`, `reviewQuestion`), a button «أرسل التقييم واكسب ${n×2} نقطة»; after sending «شكراً! أضفنا لك ${points} نقطة» and a link to «نقاطي». Empty: «لا توجد طلبيات تنتظر تقييمك».
- Home: a card «⭐ قيّم خدمتنا واكسب ${n×2} نقطة · عندك ${n} طلبيات استلمتها» linking to `/rate`, only when there are any.
- Order page: the rating card says «قيّم واكسب 3 نقاط» when the order awaits rating, and the thanks names the points.

## Testing

API (`accounting/tests/ratings.rewards.test.js`): which orders await rating (shipment received / not, purchase bought / not, other customer's, cancelled, before start, older than 30 days, already rated); one rating for several orders → one rating each and 3 points each; a second rating → nothing; the single-order route earns too and refuses another customer's order; points off → rating, no points; the reminder → one push per customer, never twice. Client: the button's points text and the card's wording.
