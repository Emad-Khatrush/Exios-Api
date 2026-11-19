# Loyalty points promotions (عروض النقاط)

Date: 2026-11-19. Builds on `2026-11-16-loyalty-points-design.md` and the levels (`accounting/services/loyalty/tiers.js`, `levels.js`).

## Goal

The owner runs time-limited points offers, such as «الجمعة البيضاء» for a week: orders placed during the offer earn more points (×1.5, ×2, ×3…), on the kinds of orders, shipping methods and countries the owner picks. Customers are told when an offer starts and see it in the app while it runs.

## Decisions (owner, 2026-11-19)

1. **The order's creation date decides.** An order created between the offer's start and end is in the offer, even if it is paid and delivered (and so earns) weeks after the offer ended.
2. **Staff choose:** the multiplier, the kinds of orders, the shipping method, the countries. Not specific customers or levels.
3. **Highest wins, no stacking.** Points = base points × max(level multiplier, offer multiplier). Two overlapping offers: the higher one.
4. **Customers are notified** on their phones (and the notifications page) when an offer starts.

## What stays as it is

- Points are still earned only when an invoice is fully paid (shipping: also delivered), by the hourly `awardDue` job.
- The level still counts **base points** (`basePoints`, before any multiplier), so an offer never inflates a level.
- Expiry, redemption, the 20% cap, "no points", points switched off: unchanged.

## Data: `LoyaltyPromotion` (new model, `models/loyaltyPromotion.js`)

| field | type | meaning |
|---|---|---|
| `name` | String, required, ≤ 60 | «الجمعة البيضاء» |
| `multiplierPct` | integer 110 … 500, step 10 | 200 = ×2; whole percents like the levels' `multiplierPct`, so the math stays integer |
| `startsAt` / `endsAt` | Date | start of the first day / end of the last day, Libya time (Africa/Tripoli); `endsAt > startsAt` |
| `kinds` | ['shipping' \| 'purchase' \| 'remittance'], ≥ 1 | shipping = package claims (SHP); purchase = purchase invoice claims (PUR, not remittance); remittance = PUR of `isRemittance` orders (Alipay, SWIFT) |
| `methods` | ['air' \| 'sea'], empty = both | shipping claims only |
| `countries` | [country key], empty = all | shipping claims only; keys `china`, `uae`, `turkey`, `usa`, `uk`… |
| `notify` | Boolean | tell customers when it starts |
| `notifiedAt` | Date | set once the start notification went out |
| `endedEarlyAt` | Date | set when staff end it early (also moves `endsAt` to that moment) |
| `createdBy`, timestamps | | |

## Which offer a claim gets (`promotions.js` beside the loyalty service, pure functions + one query)

`bestPromotion(claim, order, promotions)`:

- The claim's kind: `shipment` → `shipping`; `purchase` → `remittance` when `order.isRemittance`, else `purchase`. Domestic and customs fee claims never earn (unchanged), so never match.
- Date: `promotion.startsAt <= order.createdAt < promotion.endsAt`.
- Shipping claims also match `methods` (the package's `deliveredPackages.shipmentMethod`, else `order.shipment.method`; an unknown method matches only an offer with no method filter) and `countries` (`order.shipment.fromWhere`, normalised from Arabic or English to a key, as the client's `countryKey`; an unnamed or unknown origin matches only an offer with no country filter).
- Among the matching offers: the highest multiplier (then the earliest start, to be stable).

## Earning (`earnClaim`)

```
levelPct = tiers.tierOf(level).multiplierPct
promo    = bestPromotion(claim, order, promotionsAround(order.createdAt))
pct      = max(levelPct, promo?.multiplierPct || 100)
points   = floor(basePoints × pct / 100)     // the same rounding as tiers.multiplied today
```

The earn movement also stores `promotion: { id, name, multiplierPct }` when the offer is what decided `pct` (`promo.multiplierPct > levelPct`). The history shows «كسب من طلبية · الجمعة البيضاء ×2».

`pendingOf` / `orderLoyalty` / `client/loyalty` show points on the way with the same `x`, and the offer, so the customer sees from the start what the order will bring.

## Editing rules (protect points already promised)

- Before it starts: everything can change; it can be deleted.
- Once started: only `name` and `notify` can change, and it can be **ended early** (`endsAt = now`, `endedEarlyAt = now`). Orders created before that moment stay in it. Not deletable.
- After it ended: read only.

## Start notification

A job added to `runLoyaltyJobs` (hourly) and also run right after an offer is created or edited: offers with `notify`, `startsAt <= now < endsAt` and no `notifiedAt` get `notifiedAt` set (atomically, so it goes out once) and then `customerPush.promotionStarted(promotion)` → `sendToAll` (saved for every customer's notifications page; pushed to devices). Text: title «🔥 الجمعة البيضاء: نقاطك ×2», body naming what it covers and the last day, url `/points`. Customers whose points are switched off still see it on the page (sendToAll has no per-customer filter); acceptable.

An offer created with a start date already reached notifies at once.

## API

Staff (permission `loyalty`, admins all):

- `GET loyalty/promotions` → all offers, newest first, each with `state` (upcoming | active | ended) and, for active/ended ones, `orders` (claims earned with it) and `bonusPoints` (points earned above what the level alone gave).
- `POST loyalty/promotions` → create (validation above).
- `PUT loyalty/promotions/:id` → edit within the editing rules (400 with an Arabic message otherwise).
- `POST loyalty/promotions/:id/end` → end early.
- `DELETE loyalty/promotions/:id` → only upcoming ones.

Customer:

- `GET client/loyalty/promotions` → active and upcoming offers (name, multiplier, startsAt, endsAt, kinds, methods, countries); `{ off: true }` when the customer's points are switched off.

## Admin (exios-admin)

On the Loyalty page, a tab «العروض»: offers grouped upcoming / running / ended, with what each covers, its dates, and for running/ended ones the orders and bonus points. «عرض جديد» opens a form: name, multiplier (quick picks ×1.5 ×2 ×3, or typed), from/to dates, kinds (checkboxes, at least one), methods (air / sea / both), countries (chips, empty = all), «أبلغ العملاء عند بداية العرض» (on by default). A running offer shows «إنهاء العرض الآن» with a confirm; an upcoming one can be edited or deleted.

## Client app (Exios-Client)

- `GET client/loyalty/promotions` read by the points page and the home points card.
- **Points page:** above the balance, a banner per running offer: «🔥 الجمعة البيضاء · نقاطك ×2 على الشحن من الصين حتى الجمعة 28 نوفمبر», a live countdown (days, hours) and «اطلب الآن» linking to «ابدأ الشحن» (shipping) or the purchase prices (purchase). An upcoming offer shows smaller: «يبدأ بعد يومين».
- **Home points card:** a small «×2 الآن» flame tag while an offer runs.
- **Order page and history:** the order's points line and the history row mention the offer (from the API fields above).
- **Points terms:** a section «العروض»: an offer multiplies the points of orders created during it; you get the higher of your level and the offer, not both; offers do not count towards the level.

## Testing

API (`accounting/tests/loyalty.promotions.test.js`, local like the other loyalty tests):
- matching: each kind; methods; countries (Arabic and English names); unknown method/country; dates on the first and last day in Libya time, and just outside.
- multiplier: offer above the level; level above the offer (no promotion recorded); two overlapping offers.
- level points unchanged by an offer (`basePoints`).
- editing rules: started offer refuses multiplier/date/scope changes and delete; ending early keeps earlier orders in.
- start notification goes out once, and only for `notify` offers.

Client: unit test of the banner text and countdown helpers; visual check of the banner.

## Not in scope

Offers for chosen customers or levels; fixed bonus points per order; offers on redemption.
