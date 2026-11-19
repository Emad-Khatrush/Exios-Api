# Loyalty Points Promotions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Time-limited points offers (×1.1–×5) on orders created during the offer, chosen by kind, shipping method and country, announced to customers when they start and shown in the client app.

**Architecture:** A `LoyaltyPromotion` model and a pure matcher (`accounting/services/loyalty/promotions.js`) in Exios-Api. `earnClaim` and `pendingOf` take `max(level %, best offer %)`; the hourly loyalty jobs announce started offers. Staff manage offers from a new admin page; the client app reads active offers and shows a banner, a tag and the offer on earned rows.

**Tech Stack:** Node/Express/Mongoose + Jest (mongodb-memory-server via `accounting/tests/helpers`) in Exios-Api; React 18 + MUI in exios-admin; React 18 + TypeScript + Jest in Exios-Client. All on branch `client-update` in each repo.

**Spec:** `Exios-Api/docs/superpowers/specs/2026-11-19-loyalty-promotions-design.md`

## Global Constraints

- The order's `createdAt` decides: `startsAt <= order.createdAt < endsAt`.
- Points = `floor(basePoints × max(levelPct, promoPct) / 100)`; `basePoints` unchanged (the level counts it).
- `multiplierPct` integer 110…500, step 10. `kinds` ⊆ {shipping, purchase, remittance}, ≥ 1. `methods` ⊆ {air, sea} (empty = both). `countries` keys (empty = all). Method/country filters apply to shipping claims only.
- Days are Libya time (`TZ` from `accounting/services/dates.js`): `startsAt` = 00:00 of the first day, `endsAt` = 00:00 of the day after the last day.
- Started offer: only `name`, `notify` editable; can be ended early (`endsAt = now`, `endedEarlyAt = now`); not deletable. Ended: read only.
- Customer copy is Arabic; the client app calls the level «عضويتك».
- Earn movements record `promotion: { id, name, multiplierPct }` only when the offer decided the multiplier.
- Nothing is deployed in this plan; QA deploy is a separate request (API and admin go through the `Exios-System-render-fix` mirror).

## Review Focus

- An order whose `shipment.fromWhere` is `CN`, `الصين`, ` China ` or empty → the first three match a China offer, empty matches only an offer with no country filter. (Task 1 tests.)
- An offer edited after it started (multiplier, dates, kinds) → refused with an Arabic 400, the earned/pending points do not move. (Task 3 tests.)
- An order created on the offer's last day at 23:30 Libya time → in; at 00:00 the day after → out. (Task 1 tests.)
- A remittance order (`isRemittance`) under a «purchase»-only offer → not matched; under «remittance» → matched. (Task 1 tests.)
- The start notification when the hourly job and a create race → sent once (atomic `notifiedAt` claim). (Task 4 tests.)

---

### Task 1: Model and matcher (Exios-Api)

**Files:**
- Create: `models/loyaltyPromotion.js`
- Create: `accounting/services/loyalty/promotions.js`
- Test: `accounting/tests/loyalty.promotions.test.js` (local, gitignored like the other loyalty tests)

**Interfaces:**
- Produces (`promotions.js`):
  - `countryKey(text): string` — `'china'|'uae'|'turkey'|'usa'|'uk'|''`; accepts Arabic (with/without hamza), English, ISO-like `CN`/`AE`/`TR`/`US`/`UK`/`GB`, trimmed, case-insensitive.
  - `claimScope(arKey, order): { kind: 'shipping'|'purchase'|'remittance', method: 'air'|'sea'|'', country: string } | null` — null for domestic/customs fee keys (use `parseKey` from `../claims/keys`).
  - `matches(promotion, scope, createdAt): boolean`
  - `bestPromotion(promotions, scope, createdAt): promotion | null` — highest `multiplierPct`, then earliest `startsAt`.
  - `promotionsAround(dates: Date[], session?): Promise<promotion[]>` — lean offers with `startsAt <= max(dates)` and `endsAt > min(dates)`.
  - `dayRange(fromDay: 'YYYY-MM-DD', toDay: 'YYYY-MM-DD'): { startsAt: Date, endsAt: Date }` (Libya time, end exclusive).
- Model fields exactly as the spec table (`name`, `multiplierPct`, `startsAt`, `endsAt`, `kinds`, `methods`, `countries`, `notify`, `notifiedAt`, `endedEarlyAt`, `createdBy`, timestamps); index `{ startsAt: 1, endsAt: 1 }`.

- [ ] **Step 1: Write failing tests** (pure, no DB needed except `promotionsAround`)

```js
const P = require('../services/loyalty/promotions');
const promo = (o = {}) => ({ _id: 'p1', name: 'X', multiplierPct: 200, kinds: ['shipping'], methods: [], countries: [], ...P.dayRange('2026-11-20', '2026-11-26'), ...o });
const at = (iso) => new Date(iso);

test('countryKey reads every way the office writes a country', () => {
  for (const t of ['الصين', ' China ', 'CN', 'china']) expect(P.countryKey(t)).toBe('china');
  expect(P.countryKey('الامارات')).toBe('uae'); expect(P.countryKey('الإمارات')).toBe('uae');
  expect(P.countryKey('')).toBe(''); expect(P.countryKey('-')).toBe('');
});
test('the last day counts up to midnight Libya time', () => {
  const s = { kind: 'shipping', method: 'air', country: 'china' };
  expect(P.matches(promo(), s, at('2026-11-26T21:30:00Z'))).toBe(true);  // 23:30 Tripoli
  expect(P.matches(promo(), s, at('2026-11-26T22:00:00Z'))).toBe(false); // 00:00 next day
  expect(P.matches(promo(), s, at('2026-11-19T22:00:00Z'))).toBe(true);  // 00:00 first day
});
test('method and country filter shipping only; unknown matches only open offers', () => {
  const sea = promo({ methods: ['sea'], countries: ['china'] });
  expect(P.matches(sea, { kind: 'shipping', method: 'sea', country: 'china' }, at('2026-11-21T10:00:00Z'))).toBe(true);
  expect(P.matches(sea, { kind: 'shipping', method: 'air', country: 'china' }, at('2026-11-21T10:00:00Z'))).toBe(false);
  expect(P.matches(sea, { kind: 'shipping', method: '', country: 'china' }, at('2026-11-21T10:00:00Z'))).toBe(false);
  expect(P.matches(promo(), { kind: 'shipping', method: '', country: '' }, at('2026-11-21T10:00:00Z'))).toBe(true);
  const buy = promo({ kinds: ['purchase'], countries: ['china'] });
  expect(P.matches(buy, { kind: 'purchase', method: '', country: '' }, at('2026-11-21T10:00:00Z'))).toBe(true);
});
test('remittance is its own kind', () => {
  const s = { kind: 'remittance', method: '', country: '' };
  expect(P.matches(promo({ kinds: ['purchase'] }), s, at('2026-11-21T10:00:00Z'))).toBe(false);
  expect(P.matches(promo({ kinds: ['remittance'] }), s, at('2026-11-21T10:00:00Z'))).toBe(true);
});
test('the best of overlapping offers is the highest', () => {
  const s = { kind: 'shipping', method: 'air', country: 'china' };
  expect(P.bestPromotion([promo({ _id: 'a', multiplierPct: 150 }), promo({ _id: 'b', multiplierPct: 300 })], s, at('2026-11-21T10:00:00Z'))._id).toBe('b');
  expect(P.bestPromotion([], s, at('2026-11-21T10:00:00Z'))).toBeNull();
});
test('claimScope reads the package method, then the order method', () => { /* order with paymentList[0].deliveredPackages.shipmentMethod 'sea', shipment.method 'air', fromWhere 'الصين' → { kind: 'shipping', method: 'sea', country: 'china' }; PUR key on isRemittance order → kind 'remittance' */ });
```

- [ ] **Step 2: Run** `npx jest accounting/tests/loyalty.promotions.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the model and `promotions.js` with the signatures above.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(loyalty): promotions model and matcher`.

---

### Task 2: Earning and points on the way use the offer (Exios-Api)

**Files:**
- Modify: `accounting/services/loyalty/index.js` (`ORDER_FIELDS`, `earnClaim`, `pendingOf`, `historyOf` select)
- Modify: `models/loyaltyPoint.js` (add `promotion: { id: ObjectId, name: String, multiplierPct: Number }`)
- Test: `accounting/tests/loyalty.promotions.test.js` (DB tests, using `loyaltyKit`)

**Interfaces:**
- Consumes: Task 1 `claimScope`, `promotionsAround`, `bestPromotion`.
- Produces: `multiplierFor(levelKey, promo): { pct: number, promotion: {id,name,multiplierPct}|null }` exported from `promotions.js`; pending rows gain `promotion` (same shape or null); history rows gain `promotion`; `orderLoyalty(orderId)` gains `promotion` (from its earn movements, else its pending rows; null when none) — the client's order page reads it.

- [ ] **Step 1: Failing tests** (create offers with `LoyaltyPromotion.create(...)` covering the order's `createdAt`; `makeOrder`, `pay`, `deliver`, `loyalty.awardDue` from the kit):
  - `offer ×2 doubles a bronze customer's purchase points and records the offer`: $20 invoice → earn `points: 20`, `basePoints: 10`, `promotion.multiplierPct: 200`.
  - `a gold customer keeps ×1.25 when the offer is lower`: level gold (`setLevelRaw` as in levels test), offer 110 → `points: 12`, `promotion` undefined.
  - `the offer does not count towards the level`: after a ×3 earn, `loyaltyTier` points/level computed from `basePoints` (level stays bronze for 400 base points).
  - `an order created before the offer earns normally even if paid during it`.
  - `pending shows the offer`: `loyalty.orderLoyalty(order._id)` before payment → `pending` doubled; `pendingOf` row `.promotion.name` set.
- [ ] **Step 2: Run** `npx jest accounting/tests/loyalty.promotions.test.js` — FAIL.
- [ ] **Step 3: Implement.** Add `shipment.method shipment.fromWhere paymentList.deliveredPackages.shipmentMethod` to `ORDER_FIELDS`. In `earnClaim` replace `tiers.multiplied(state.points, level)` with `multiplierFor` + `Math.floor(state.points * pct / 100)` and store `promotion` when set. In `pendingOf` load `promotionsAround(eligible.map(o => o.createdAt), session)` once, apply per row the same way. `historyOf` selects `promotion`.
- [ ] **Step 4: Run** the promotions test and `npx jest accounting/tests/loyalty` — all loyalty suites PASS.
- [ ] **Step 5: Commit** `feat(loyalty): offers multiply earned and pending points`.

---

### Task 3: Staff API (Exios-Api)

**Files:**
- Create: `controllers/loyaltyPromotions.js`
- Modify: `routes/loyalty.js`
- Modify: `accounting/services/loyalty/promotions.js` (`create`, `update`, `endNow`, `remove`, `listForStaff`, `activeForCustomers`)
- Test: `accounting/tests/loyalty.promotions.test.js`

**Interfaces:**
- Produces routes (permission `allow(['loyalty'])`): `GET loyalty/promotions`, `POST loyalty/promotions`, `PUT loyalty/promotions/:id`, `POST loyalty/promotions/:id/end`, `DELETE loyalty/promotions/:id`; customer `GET client/loyalty/promotions` (`protect, isClient`).
- Request body: `{ name, multiplierPct, fromDay, toDay, kinds, methods, countries, notify }` (`fromDay`/`toDay` 'YYYY-MM-DD', converted with `dayRange`).
- Staff row: promotion fields + `state: 'upcoming'|'active'|'ended'`, `orders` (count of earn movements with `promotion.id`), `bonusPoints` (sum of `points - multiplied(basePoints, tier)` on those movements).
- Customer: `{ promotions: [{ id, name, multiplierPct, startsAt, endsAt, kinds, methods, countries, state }] }` for active and upcoming; `{ off: true }` when points are off (reuse `isOff`).

- [ ] **Step 1: Failing tests** (service level, `now` injectable):
  - validation: multiplier 105 / 510 / 155 refused; empty kinds refused; `toDay < fromDay` refused; Arabic messages.
  - `update` of a started offer changing `multiplierPct`, `fromDay`, `kinds` → throws 400 «لا يمكن تعديل عرض بدأ…»; changing `name` and `notify` works.
  - `endNow` on an active offer sets `endsAt = now`, an order created before it still earns ×2 afterwards.
  - `remove` refused once started; works when upcoming.
  - `listForStaff` gives `orders: 1`, `bonusPoints: 10` after one ×2 earn of 10 base points.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the service functions, the controller (thin, `runInTransaction` for writes, `ErrorHandler` 400s) and the routes.
- [ ] **Step 4: Run** the promotions test and `npx jest accounting/tests/loyalty.api.test.js` — PASS.
- [ ] **Step 5: Commit** `feat(loyalty): manage points offers (staff) and list them (customers)`.

---

### Task 4: Start notification (Exios-Api)

**Files:**
- Modify: `utils/customerPush.js` (add `promotionStarted(promotion)`)
- Modify: `accounting/services/loyalty/promotions.js` (`announceStarted({ now })`)
- Modify: `accounting/index.js` (`runLoyaltyJobs` list gains `['promotions', promotions.announceStarted]`)
- Modify: `controllers/loyaltyPromotions.js` (call `announceStarted()` after create/update, not awaited by the response)
- Test: `accounting/tests/loyalty.promotions.test.js`

**Interfaces:**
- `announceStarted({ now = new Date() }): Promise<{ announced: number }>` — for each offer with `notify`, `startsAt <= now < endsAt`, no `notifiedAt`: `findOneAndUpdate({ _id, notifiedAt: { $exists: false } }, { $set: { notifiedAt: now } })`, and only when that returned the doc, `customerPush.promotionStarted(p)`.
- Message: title `🔥 ${name}: نقاطك ×${pct/100}`; body `على ${what} لكل طلبية تُنشئها حتى ${lastDay}.` where `what` joins «الشحن» (+ « الجوي»/« البحري» when one method, + « من الصين»… when countries), «فواتير الشراء», «الحوالات» with « و»; `lastDay` = `endsAt - 1 day` as «الجمعة 28 نوفمبر» (moment `ar` locale, Latin digits); `url: '/points'`, `tag: 'promotion'`.

- [ ] **Step 1: Failing tests** (mock `utils/customerPush` with `jest.mock`): two `announceStarted` calls in parallel → `promotionStarted` called once; `notify: false` → not called; upcoming → not called; message text for `{ kinds: ['shipping'], methods: ['sea'], countries: ['china'] }` equals `على الشحن البحري من الصين لكل طلبية تُنشئها حتى الجمعة 28 نوفمبر.` (test the text builder `promotionText(p)` exported from customerPush).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; then `npx jest accounting/tests/loyalty` — PASS.
- [ ] **Step 5: Commit** `feat(loyalty): tell customers when a points offer starts`.

---

### Task 5: Admin page «عروض النقاط» (exios-admin)

**Files:**
- Create: `src/containers/Loyalty/LoyaltyPromotions.tsx`, `src/containers/Loyalty/PromotionDialog.tsx`
- Modify: `src/App.tsx` (route `/loyalty/promotions` in both route lists, beside `/loyalty/levels`)
- Modify: `src/containers/Loyalty/LoyaltyCustomers.tsx` (header link «عروض النقاط» beside «المستويات وتقريرها»)
- Modify: `src/containers/Loyalty/loyalty.scss`

**Interfaces:**
- Consumes: Task 3 routes and shapes.
- Page: `LoyaltyRtl` + `lp lp-page` layout like `LoyaltyLevels`; three groups (جارية / قادمة / منتهية), each card: name, `×N`, dates, what it covers (same wording as the push), for active/ended `orders` and `bonusPoints`; active → «إنهاء العرض الآن» (confirm dialog); upcoming → «تعديل», «حذف».
- Dialog fields: name; multiplier quick chips ×1.5 ×2 ×3 + number input (×1.1–×5, step 0.1 → `multiplierPct`); from/to date inputs; kinds checkboxes (الشحن، فواتير الشراء، الحوالات); method (الكل / جوي / بحري); countries chips (الصين، الإمارات، تركيا، أمريكا، بريطانيا; none = all); «أبلغ العملاء عند بداية العرض» on by default. For an active offer only name and notify are enabled. Errors via `requestError`.

- [ ] **Step 1:** Implement page and dialog.
- [ ] **Step 2: Verify** `npx tsc --noEmit -p .` in exios-admin — no new errors; open `/loyalty/promotions` against a local API, create an offer, see it listed, edit name of an active offer, end it.
- [ ] **Step 3: Commit** `feat(loyalty): admin page for points offers`.

---

### Task 6: Client app (Exios-Client)

**Files:**
- Modify: `src/api/index.ts` (`getLoyaltyPromotions: () => base.get('client/loyalty/promotions')`)
- Modify: `src/containers/PointsPage/loyaltyTypes.ts` (`LoyaltyPromotion` type; `promotion?` on `LoyaltyHistoryRow`, `LoyaltyPending`)
- Create: `src/containers/PointsPage/promotions.ts` (`promotionLine(p): string`, `timeLeft(endsAt, now): { days, hours, text }`, `isActive(p, now)`)
- Create: `src/containers/PointsPage/PromotionBanner.tsx`
- Modify: `src/containers/PointsPage/PointsPage.tsx` (banners above the balance; history row shows «· ${name} ×N»; pending row tag)
- Modify: `src/containers/Home/PointsCard.tsx` («×N الآن» flame tag while one runs)
- Modify: `src/containers/OrderInfoPage/OrderPoints.tsx` (under the order's points: «🔥 ضمن عرض ${name} ×N» when `data.promotion`), and `OrderLoyalty` type gains `promotion?`
- Modify: `src/containers/PointsPage/pointsTerms.ts` (section «العروض» after «المستويات»)
- Modify: `src/containers/PointsPage/points.css`
- Test: `src/__tests__/promotions.test.ts`

**Interfaces:**
- Consumes: Task 3 customer shape, Task 2 `promotion` on history/pending rows.
- `promotionLine({ name, multiplierPct: 200, kinds: ['shipping'], methods: ['sea'], countries: ['china'], endsAt })` → `نقاطك ×2 على الشحن البحري من الصين حتى الجمعة 28 نوفمبر` (same wording rules as Task 4).
- `timeLeft`: «باقي 3 أيام و5 ساعات», «باقي 5 ساعات», «ينتهي خلال ساعة».
- Banner: flame icon, name, `promotionLine`, live countdown (updates each minute), button «اطلب الآن» → `/start-shipment` when kinds include shipping, else `/prices/purchase`. Upcoming offers: a smaller line «يبدأ ${relative}». Nothing when the request fails or `off`.
- Terms text: «العرض يضاعف نقاط الطلبيات التي تُنشئها خلال مدته، حتى لو دفعتها واستلمتها بعده.», «تأخذ الأعلى بين مضاعفة عضويتك ومضاعفة العرض، لا الاثنين معاً.», «نقاط العرض الإضافية لا تُحسب لعضويتك.»

- [ ] **Step 1: Failing test** `src/__tests__/promotions.test.ts` for `promotionLine` (the example above; purchase-only → «على فواتير الشراء»; all kinds no filters → «على الشحن وفواتير الشراء والحوالات») and `timeLeft` (the three texts).
- [ ] **Step 2: Run** `npx jest src/__tests__/promotions.test.ts` — FAIL.
- [ ] **Step 3: Implement** helpers, banner, page/card/terms changes.
- [ ] **Step 4: Run** `npm run check` — PASS, no new lint errors; render the banner (headless Chrome, as before) and look at it.
- [ ] **Step 5: Commit** `feat(points): show running points offers`.
