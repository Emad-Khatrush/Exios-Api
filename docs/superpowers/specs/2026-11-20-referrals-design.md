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
| Inviter's big reward, once the friend has paid **$200 in total** (over any number of orders) of shipping or purchases | 1,000 | $10 |
| Inviter's share, 12 months from that moment | **10 points per $50** the friend pays (whatever the friend's own multiplier) | 0.2% |
| Steps: 3 friends who reached $200 **and** $2,000 paid by all friends / 5 and $5,000 / 10 and $10,000 | +1,000 / +2,000 / +5,000 (and the title «سفير إكسيوس») | $10 / $20 / $50 |

Changed by the owner on 2026-11-20 (first version: $50, 5 points per $20, steps on friends only). Later the same day: the inviter's reward 1,000 → **500 ($5)** and the friend's welcome 500 → **300 ($3)**.

**24 hours on hold** (owner, 2026-11-20): every reward of the inviter (big reward, share, steps) is a `ReferralReward` with `releaseAt` = earn + 24 h. The hourly job (`referrals.runDue`) gives it when the friend's earn still stands (`earnStillValid`: order not cancelled, claim fully paid, same points: not repriced or written off), else cancels it (a cancelled big reward lets the friend qualify again, with a new key). A reward given whose order is cancelled later is taken back (`takeBackDue`); a big reward only when the friend no longer reaches $200. "Paid" no longer counts cancelled orders.

**Passport number** (owner, 2026-11-20, against duplicate accounts): read from the photo at sign-up (Google Cloud Vision, MRZ with its check digit, `utils/passportNumber.js`), confirmed by the customer, unique (`passportVerification.number`, sign-up refused with `passport-exist`), required and editable when staff approve. Passport photos: images only.

**Protections** (owner, 2026-11-20):
- A friend's rewards (big reward, share) wait, beyond the 24 hours, until the friend's passport is verified; steps count only verified friends.
- Suspicious referrals: same device at sign-up (same address AND browser; a shared network alone is not a sign) or the same family name → `referral.flags`, `referral.review.status = 'pending'`; their rewards wait until staff approve (reject cancels the referral and what waited).
- Step rewards always wait for staff approval (rejected: never offered again).
- Staff page «مراجعة الدعوات» (`/loyalty/referrals`): the review queue and a report of referrals set by hand, by staff member.
- Older accounts' passport numbers: `scripts/backfillPassportNumbers.js` (dry run by default) reads each stored photo once; a checked number is saved, an unchecked one waits for staff, two accounts with the same number are both marked `numberConflict`. Sign-up also refuses a number read from an older photo.

**New account's gift** (owner, 2026-11-20): every account opened without an inviter gets **100 points** at sign-up (`SIGNUP_GIFT:<userId>`, «هدية فتح الحساب»). Invited: 500 in all, never both; when staff set the inviter later, the welcome adds only what is missing (400).

**«سفير إكسيوس»** (owner, 2026-11-20, "balanced"): reaching the last step (10 friends, $10,000; owner moved it there 2026-11-20) sets `referral.ambassadorAt`. From then on the inviter's share is **15 points per $50** (not retroactive: only friends' earns from that moment). A badge shows it: under the name in the app's menus, on the invite page, and in the admin's Points tab.

4. **The inviter's rewards count toward their level** (owner, 2026-11-20): only the share is an add carrying `levelPoints` (the big reward and the steps do NOT count: owner, later the same day; they are for spending only) (= their points), and `levelPointsOf` counts them within the same 365-day window as earns. The friend's welcome gift and every other gift still do not count. Effect: the level rises with what friends actually pay (10 level points per $50), never from one-off rewards.

## Rules

- **Code:** every customer has one personal code (6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, no look-alikes), made the first time they open the invite page. Link: `<app>/r/<code>`.
- **Who can be invited:** only a new account. The code is given at sign-up (link or typed), or by staff in the customer's profile within **7 days** of the account's creation. Once set it never changes; staff can only cancel it.
- **Refused:** one's own code, an unknown code, a code of a staff account, an inviter whose points are off, and a friend who already has an inviter.
- **Welcome gift:** given when the referral is set (sign-up or staff), once ever per friend. Spent like any points: by staff, at most 20% of an invoice. Not given when the friend's points are off.
- **"Paid":** read from the friend's earns: the sum of `basePoints` × $2 (10 points per $20 before any multiplier; an Alipay transfer earns half, so counts half).
- **"Qualified" friend:** the moment the friend has paid **$200** in total. The invite page shows the inviter what each friend still has to pay (`leftUsd`). This is counted from real earns only, so it already means paid, delivered, after `LOYALTY_START_DATE`, not cancelled, not "no points".
- **Big reward:** to the inviter, in the same transaction as the friend's earn that made them qualified.
- **Share:** for every earn of the friend from the qualifying one until `qualifiedAt + 365 days`: `floor(basePoints × 2 × 10 / 50)` to the inviter, in the same transaction as the friend's earn. The friend's own points are never reduced: the company pays the share.
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
  qualifiedAt: Date,                      // when they reached $200 paid
  canceledAt: Date, canceledBy: ObjectId, cancelReason: String }
```
Index on `referral.by`.

## API

Service: `accounting/services/loyalty/referrals.js` (all numbers at its top), called from `earnClaim` after the friend's earn (`afterEarn(movement, session)` → returns what to push), from `createUser`, and from the routes below.

Client:
- `GET client/referrals` → `{ code, path: '/r/<code>' (the app adds its own address), welcomePoints, firstPoints, sharePerTwenty, months: 12, steps: [{ friends, points, reached }], friends: [{ name (first name + initial), joinedAt, status: 'joined'|'sharing'|'ended'|'canceled', qualifiedAt, shareEndsAt, points }], totalPoints, off }`.
- `GET referrals/check/:code` (public, rate-limited like the signup check) → `{ ok, name, welcomePoints }` so the sign-up page can say «دعاك أحمد».
- `POST account/create` accepts an optional `referralCode` (and `referralSource: 'link'|'code'`) and answers `referral: { ok, inviterName, welcome } | { ok: false, message }`. A wrong code never blocks the sign-up: the account is made without a referral and the app says so.

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

API (`accounting/tests/referrals.test.js`): code made once and unique; sign-up with a good code → referral + welcome gift once; own / unknown / staff / off inviter's code → no referral, account still made; staff set after 7 days → refused; friend below $200 → nothing and the page shows what is left; the earn crossing $200 over several orders → big reward + share on that earn; later earns within 365 days → 10 per $50, after → nothing; friend's multiplier does not change the share; inviter off → nothing; cancelled referral → nothing more; steps need both the friends and the dollars, checked on every earn, once each; every reward once (eventKeys). Client: the WhatsApp message and link, the ladder text, the friend status wording, the saved code from `/r/:code`.
