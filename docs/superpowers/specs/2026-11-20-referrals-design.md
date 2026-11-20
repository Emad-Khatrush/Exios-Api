# Invite a friend (ادعُ صديقك)

Date: 2026-11-20. Builds on the loyalty points (`2026-11-16-loyalty-points-design.md`), the levels and the rating rewards (`2026-11-19-rating-rewards-design.md`).

## Goal

Customers bring new paying customers. Both sides gain: the friend gets a welcome gift, and the customer who invited them gets a big reward when the friend pays their first orders, then a share of every shipment the friend pays for during 12 months. A ladder of extra rewards turns good inviters into regular promoters.

## Decisions (owner, 2026-11-20)

1. **Two-sided:** a welcome gift for the friend and rewards for the inviter.
2. **The inviter's big reward comes only after the friend has paid**, never at sign-up.
3. **A share for 12 months:** after the big reward, the inviter earns on every order the friend pays for, for 12 months, then it stops.

Numbers proposed by me (the owner chose "about $15 per new customer" as the direction; may still tune them, all in one file):

| What | Points | Money |
|---|---|---|
| Friend's welcome gift, at sign-up with a code | 500 | $5 |
| Inviter's big reward, once the friend has paid $50 of shipping or purchases | 1,000 | $10 |
| Inviter's share, 12 months from that moment | half of what the friend earns before the friend's own multiplier (5 points per $20) | 0.25% |
| Ladder: 3 / 5 / 10 friends who reached the big reward | +1,000 / +2,000 (and the title «سفير Exios») / +5,000 | $10 / $20 / $50 |

**Open for the owner:** referral points do **not** count toward the level, like every other gift today (levels stay about a customer's own shipping, so nobody reaches credit delivery or a special price without shipping). If the owner wants them to count, it is one change in `levels.js`.

## Rules

- **Code:** every customer has one personal code (6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, no look-alikes), made the first time they open the invite page. Link: `<app>/r/<code>`.
- **Who can be invited:** only a new account. The code is given at sign-up (link or typed), or by staff in the customer's profile within **7 days** of the account's creation. Once set it never changes; staff can only cancel it.
- **Refused:** one's own code, an unknown code, a code of a staff account, an inviter whose points are off, and a friend who already has an inviter.
- **Welcome gift:** given when the referral is set (sign-up or staff), once ever per friend. Spent like any points: by staff, at most 20% of an invoice. Not given when the friend's points are off.
- **"Qualified" friend:** the moment the friend's paid earnings (sum of `basePoints` of their `earn` movements, i.e. $50 at 10 points per $20 = 25 base points) reach **25**. This is counted from real earns only, so it already means paid, delivered, after `LOYALTY_START_DATE`, not cancelled, not "no points".
- **Big reward:** to the inviter, in the same transaction as the friend's earn that made them qualified.
- **Share:** for every earn of the friend from the qualifying one until `qualifiedAt + 365 days`: `floor(basePoints / 2)` to the inviter, in the same transaction as the friend's earn. The friend's own points are never reduced: the company pays the share.
- **Ladder:** counted on qualified friends with an active referral; each step given once ever.
- **Inviter's points off:** no reward or share is given while off, and it is not paid later.
- **Cancelling a referral** (staff, with a reason): no further rewards or share from that friend. What was already given stays; staff can deduct it with the usual deduction if needed.
- **Cancelled orders:** rewards already given are not taken back automatically (the earn only happens after full payment and delivery, so this is rare). Staff deduct by hand.

All rewards are loyalty `add` movements through `grantGift`, so each has its accounting entry (Dr loyalty_expense / Cr loyalty_points) and happens once per `eventKey`:

| Reward | eventKey | Reason (shown in history) |
|---|---|---|
| Welcome | `REFERRAL_WELCOME:<friendId>` | «هدية الانضمام بدعوة صديق» |
| Big reward | `REFERRAL_FIRST:<friendId>` | «مكافأة دعوة: ${friendFirstName} دفع أول طلبياته» |
| Share | `REFERRAL_SHARE:<friend earn movement id>` | «حصتك من شحن صديقك ${friendFirstName}» |
| Ladder | `REFERRAL_STEP:<inviterId>:<3/5/10>` | «مكافأة ${n} أصدقاء» |

## Data

`User.referral` (new, optional):
```
{ code: String (unique, sparse),          // this customer's own code
  by: ObjectId User,                      // who invited them
  at: Date, source: 'link'|'code'|'staff', setBy: ObjectId User,
  qualifiedAt: Date,                      // when they reached $50 paid
  canceledAt: Date, canceledBy: ObjectId, cancelReason: String }
```
Index on `referral.by`.

## API

Service: `accounting/services/loyalty/referrals.js` (all numbers at its top), called from `earnClaim` after the friend's earn (`afterEarn(movement, session)` → returns what to push), from `createUser`, and from the routes below.

Client:
- `GET client/referrals` → `{ code, link, welcomePoints, firstPoints, sharePerTwenty, months: 12, steps: [{ friends, points, reached }], friends: [{ name (first name + initial), joinedAt, status: 'joined'|'sharing'|'ended'|'canceled', qualifiedAt, shareEndsAt, points }], totalPoints, off }`.
- `GET referrals/check/:code` (public, rate-limited like the signup check) → `{ ok, firstName }` so the sign-up page can say «دعاك أحمد».
- `POST account/create` accepts an optional `referralCode`. A wrong code never blocks the sign-up: the account is made without a referral and the app says so.

Staff (permission `loyalty_adjust`):
- `PUT user/:id/referral` `{ code }` — set within 7 days of the account's creation.
- `DELETE user/:id/referral` `{ reason }` — cancel.
- The customer's profile JSON gains `referral: { by: {id, name}, at, qualifiedAt, canceledAt }` and `invited: { count, qualified }`.

## Notifications (existing push)

- Inviter, when a friend signs up: «🎉 ${name} سجّل بدعوتك · عندما يدفع أول طلبياته تكسب 1000 نقطة».
- Inviter, big reward: «💰 كسبت 1000 نقطة · صديقك ${name} دفع أول طلبياته، وستكسب من كل شحنة له لمدة سنة».
- Inviter, shares: one push per inviter per hourly run, together: «كسبت ${n} نقطة من شحن أصدقائك».
- Inviter, ladder: «🏆 ${n} أصدقاء! أضفنا لك ${points} نقطة».
- Friend, after sign-up: «🎁 هدية 500 نقطة من صديقك ${name}، تُخصم من أول فاتورة شحن».

## Client app

- **`/invite` page «ادعُ أصدقاءك»** (signed in): headline «اكسب 10$ عن كل صديق، ومن كل شحنة له لمدة سنة»; the three steps in pictures (share → friend gets $5 → you get $10 + share); the code with copy; a big green **WhatsApp** button with a ready Arabic message and the link; a native share button; the ladder as a progress bar («باقي صديق واحد على 2000 نقطة»); the list of friends with their status («سجّل · بانتظار أول طلبية», «تكسب من شحنه · باقي 7 أشهر», «انتهت السنة») and the points each brought. Hidden when the customer's points are off.
- **`/r/:code`:** saves the code (localStorage, 30 days) and opens the sign-up page.
- **Sign-up:** an optional field «كود الدعوة» filled from the saved code; checked live («دعاك أحمد · ستحصل على 500 نقطة هدية»).
- **Home:** a card «🎁 ادعُ صديقك واكسب 10$» linking to `/invite`.
- **Menu and Points page:** a link to `/invite`.

## Admin app

- Customer profile, Points tab: «دعاه: <name>» (or «لم يُدعَ»), with set (within 7 days) and cancel; «دعا ${count} أصدقاء، ${qualified} منهم دفعوا».
- Points history already shows the reasons above; nothing else is needed for now.

## Testing

API (`accounting/tests/referrals.test.js`): code made once and unique; sign-up with a good code → referral + welcome gift once; own / unknown / staff / off inviter's code → no referral, account still made; staff set after 7 days → refused; friend's earns below 25 base points → nothing; the earn crossing 25 → big reward + share on that earn; later earns within 365 days → half of basePoints, after → nothing; friend's multiplier does not change the share; inviter off → nothing; cancelled referral → nothing more; ladder at 3/5/10 once each; every reward once (eventKeys). Client: the WhatsApp message and link, the ladder text, the friend status wording, the saved code from `/r/:code`.
