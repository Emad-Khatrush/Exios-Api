# Loyalty Points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers earn points on paid shipping, purchase and transfer invoices and pay up to 20% of a later invoice with them; staff manage points fully from the admin; customers get a full points section with clear terms; every point movement is posted to the ledger.

**Architecture:** One append-only collection of point movements (earn/add lots with `remaining`, redemptions, expiries, deductions, take-backs) is the source of truth for balances. One service in `accounting/services/loyalty/` turns movements into journal entries with `postEntry` (idempotent by `eventKey`); redemption credits the customer's claims exactly like a wallet payment (`resolveClaimKeys` / `splitOverClaims` / `claimLines`). Earning, expiry and take-backs run in the existing hourly accounting tick; redemption and adjustments are on demand.

**Tech Stack:** Node/Express/Mongoose + Jest with in-memory Mongo (Exios-Api), React/TypeScript + MUI (exios-admin, English UI), React/TypeScript + Tailwind (Exios-Client, Arabic RTL UI).

**Spec:** `Exios-Api/docs/superpowers/specs/2026-11-16-loyalty-points-design.md` (rates, rules, screens, and the customer terms copy verbatim)

## Global Constraints

- 1 point = 1 cent. Points are integers everywhere; amounts in cents are integers.
- Earn: shipping and non-remittance purchase `floor(cents / 200)`; remittance (`order.isRemittance`) `floor(cents / 400)`.
- Redeem cap: `floor(billedCents * 0.2)` per set of claims, minus points already redeemed on those claims.
- Lots expire 365 days after they are earned or added; spending is oldest-first; "expiring soon" = within 30 days.
- Accounts: `220600` نقاط العملاء (liability, requires `partner`), role `loyalty_points`; `532000` مصروف برنامج النقاط (expense, parent `53`, requires `office`), role `loyalty_expense`.
- Every journal entry balances (each test file asserts it in `afterEach`; copy that block from `accounting/tests/freeShippingCancel.test.js`).
- Points never touch wallet accounts.
- Staff permission key: `loyalty`. Admin UI copy in English; client copy in Arabic; the terms copy is verbatim from the spec.

## Review Focus

1. Two redemptions on the same order at the same moment (double tap, two staff) must not exceed the 20% cap or the balance → `redeem` and `adjust` take a per-customer lock (`lockWalletOwner`) inside the transaction; test in Task 4.
2. An order cancelled after the customer paid part of it with points gives the points back with their original expiry → Task 5 test.
3. "No points" or a staff deduction on points already partly spent: only the unspent part is taken, the balance never goes negative → Tasks 5 and 6 tests.
4. A claim repriced after its points were earned must not earn twice → earning keyed per claim (`LOYALTY_EARN:<arKey>`), Task 3 test.
5. Accounting not live yet (`settings.liveEnabled` false): movements are still recorded and balances work; entries are posted once live → Task 3 test.

---

### Task 1: Accounts, roles and permission

**Files:**
- Modify: `accounting/seed/defaults.js` (ACCOUNTS near `220500` and `531000`; ROLE_DEFAULTS; ROLE_LABELS)
- Create: `accounting/seed/loyaltySetup.js`
- Modify: `accounting/index.js:15` (call it beside `ensureMerchantSetup`)
- Modify: the staff permission list in Exios-Api (where `invoices_payments` is declared) and `exios-admin/src/constants/staffPermissions.ts` (add `loyalty`, label "Loyalty points", path `/loyalty`)
- Test: `accounting/tests/loyalty.setup.test.js`

**Interfaces:**
- Produces: `ensureLoyaltySetup(): Promise<void>`; roles `loyalty_points`, `loyalty_expense` resolvable with `resolveAccount`; permission `loyalty`.

- [ ] **Step 1: Write the failing test**

```js
test('adds the two accounts and roles once, keeping an existing mapping', async () => {
  await ensureLoyaltySetup(); await ensureLoyaltySetup();
  expect((await resolveAccount('loyalty_points')).code).toBe('220600');
  expect((await resolveAccount('loyalty_expense')).code).toBe('532000');
  expect(await Account.countDocuments({ code: { $in: ['220600', '532000'] } })).toBe(2);
});
```

- [ ] **Step 2: Run** `npx jest accounting/tests/loyalty.setup.test.js` → FAIL (module not found)
- [ ] **Step 3: Implement** add `a('220600', 'نقاط العملاء', 'Customer loyalty points', 'liability', '22', { requires: ['partner'] })`, `a('532000', 'مصروف برنامج النقاط', 'Loyalty programme expense', 'expense', '53', { requires: OFFICE_DIM })`, `loyalty_points: ['220600', ['liability']]`, `loyalty_expense: ['532000', ['expense']]` and Arabic labels. `ensureLoyaltySetup` follows `seed/qaServiceAccounts.js` (create by `seedKey: code` under the parent if missing, fill the role only when absent) without the QA database guard, then `invalidateConfig()`. Add the `loyalty` permission.
- [ ] **Step 4: Run** the test → PASS; `npx jest accounting/tests/setup.test.js` → PASS
- [ ] **Step 5: Commit** `feat(loyalty): points accounts, roles and staff permission`

### Task 2: Point movements and the rules

**Files:**
- Create: `models/loyaltyPoint.js`
- Modify: `models/order.js` (add `loyalty`)
- Create: `accounting/services/loyalty/rules.js`
- Test: `accounting/tests/loyalty.rules.test.js`

**Interfaces:**
- Produces model `LoyaltyPoint`: `{ user: ObjectId, kind: 'earn'|'add'|'restore'|'redeem'|'deduct'|'expire'|'revoke', points: Number (positive int), arKey?: String, orderId?: ObjectId, office?: String, earnedAt?: Date, expiresAt?: Date, remaining?: Number (lots: earn/add/restore only), sources?: [{ lotId: ObjectId, points: Number }] (redeem/deduct/expire/revoke), eventKey: String (unique), journalEntryId?: ObjectId, reason?: String, createdBy?: ObjectId, createdAt }`; indexes `{ user: 1, expiresAt: 1 }`, `{ arKey: 1 }`, `{ orderId: 1 }`.
- Produces order field `loyalty: { noPoints: Boolean, reason: String, by: ObjectId, at: Date }`.
- Produces `rules.js`: `earnPoints(cents: number, isRemittance: boolean): number`, `redeemCap(billedCents: number, alreadyRedeemed: number): number`, `EXPIRY_DAYS = 365`, `SOON_DAYS = 30`, `takeOldest(lots: { _id, remaining, expiresAt }[], points: number): { lotId, points }[]` (throws when the lots cover less than `points`).

- [ ] **Step 1: Write the failing tests**

```js
test('earning rounds down to whole points', () => {
  expect(earnPoints(3000, false)).toBe(15);   // $30 shipping or purchase
  expect(earnPoints(2500, false)).toBe(12);   // $25
  expect(earnPoints(3000, true)).toBe(7);     // $30 Alipay
  expect(earnPoints(199, false)).toBe(0);
});
test('redeem cap is 20% less what was already used', () => {
  expect(redeemCap(20000, 0)).toBe(4000);     // $200 invoice → 4000 points ($40)
  expect(redeemCap(20000, 3500)).toBe(500);
  expect(redeemCap(20000, 5000)).toBe(0);
});
test('spending takes the oldest lots first', () => {
  const lots = [{ _id: 'b', remaining: 50, expiresAt: new Date('2027-03-01') }, { _id: 'a', remaining: 30, expiresAt: new Date('2027-01-01') }];
  expect(takeOldest(lots, 60)).toEqual([{ lotId: 'a', points: 30 }, { lotId: 'b', points: 30 }]);
  expect(() => takeOldest(lots, 81)).toThrow();
});
```

- [ ] **Step 2: Run** `npx jest accounting/tests/loyalty.rules.test.js` → FAIL
- [ ] **Step 3: Implement** the model, the order field and `rules.js` (integer math only)
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(loyalty): point movements model and rules`

### Task 3: Earning, balance and pending

**Files:**
- Create: `accounting/services/loyalty/index.js`
- Modify: `accounting/services/posting/operations.js` (export `openBalances`, `resolveClaimKeys`, `splitOverClaims`, `claimLines`)
- Test: `accounting/tests/loyalty.earn.test.js` (fixture: the order/inventory setup of `freeShippingCancel.test.js`; bill with `syncOrder`, pay the claim with a payment entry on its `arKey`)

**Interfaces:**
- Consumes: Task 1 roles, Task 2 model and rules, `postEntry` (`../ledger`), keys (`../claims/keys`).
- Produces:
  - `awardDue({ session, now? }): Promise<{ awarded: number }>`
  - `summaryOf(userId): Promise<{ points: number, usd: number, expiringSoon: { points: number, at: Date } | null, pending: { orderId, orderNumber, arKey, points, waitingFor: 'payment'|'delivery' }[], earnedTotal: number, redeemedTotal: number }>`
  - `orderLoyalty(orderId): Promise<{ earned: number, pending: number, redeemed: number, noPoints: { reason } | null }>`

Eligible claim: `PUR:<order>` or `SHP:<order>:<package>` (not `:DOM`/`:CUS`), order not cancelled, `order.loyalty.noPoints` not set, billed > 0. Earned when open balance ≤ 0 and, for `SHP`, the package `status.received`; otherwise it is pending (`waitingFor` = `payment` when owed, else `delivery`). Amount = billed − points redeemed on that claim (billed = net receivable debits on that `arKey` from `CLAIM_EVENTS` entries). Movement `kind: 'earn'`, `eventKey: LOYALTY_EARN:<arKey>`, `expiresAt = earnedAt + 365 days`; entry `eventType: 'LOYALTY_EARN'`, same `eventKey`: Dr `loyalty_expense` (office `order.placedAt`) / Cr `loyalty_points` (partner = order.user). With `settings.liveEnabled` false the movement is recorded without `journalEntryId`; `awardDue` posts entries for movements lacking one once live.

- [ ] **Step 1: Write the failing tests**
  - `a delivered, fully paid $30 package earns 15 points and posts $0.15 expense/liability`
  - `a partly paid package is pending (waitingFor payment), a paid undelivered one pending (waitingFor delivery)`
  - `an Alipay purchase invoice of $30 earns 7 points; a regular one 15`
  - `transport and customs fee claims earn nothing; a free-shipping package earns nothing`
  - `a cancelled order or one marked noPoints earns nothing and shows nothing pending`
  - `running awardDue twice, or after a reprice, earns once`
  - `with accounting not live the points are recorded, and the entry is posted after going live`
  - `summaryOf reports balance, usd = points/100, and expiringSoon within 30 days`
- [ ] **Step 2: Run** `npx jest accounting/tests/loyalty.earn.test.js` → FAIL
- [ ] **Step 3: Implement** `awardDue`, `summaryOf`, `orderLoyalty`
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(loyalty): earn points on paid claims, balance and pending`

### Task 4: Redeeming

**Files:**
- Modify: `accounting/services/loyalty/index.js`
- Test: `accounting/tests/loyalty.redeem.test.js`

**Interfaces:**
- Consumes: `resolveClaimKeys`, `splitOverClaims`, `claimLines`, `openBalances`; `lockWalletOwner` (`utils/walletLock`).
- Produces: `redeemQuote({ userId, target }): Promise<{ balance: number, maxPoints: number, owedCents: number, billedCents: number, usedOnTarget: number }>` and `redeem({ userId, target, points }, { session, req }): Promise<{ points: number, usd: number, remainingOwedCents: number, journalEntryId }>`. `target` = the wallet payment target `{ orderId, category?: 'invoice'|'receivedGoods', packageIds? }`.

`maxPoints = min(balance, owedCents, redeemCap(billedCents, usedOnTarget))`. Reject with `ErrorHandler(400)` and an Arabic message when `points < 1`, `points > maxPoints`, or the order is not the user's. Movement `kind: 'redeem'` with `sources` from `takeOldest`, decrementing each lot's `remaining`; `eventKey: LOYALTY_REDEEM:<new ObjectId>`; entry Dr `loyalty_points` (partner) / Cr `customer_receivable` with `claimLines(splitOverClaims(keys, points / 100))`.

- [ ] **Step 1: Write the failing tests**
  - `on a $200 invoice at most 4000 points are accepted; 4001 is rejected`
  - `two goes of 2000 are accepted, a third of 1 is rejected`
  - `the customer cannot use more points than they have, or more than is still owed`
  - `redeeming credits the receivable on the claim's arKey and debits the points liability by points/100`
  - `the oldest lot is spent first`
  - `two redemptions started together never pass the cap` (`Promise.allSettled` on two `redeem` calls of 3000 each, total accepted ≤ 4000)
  - `a customer cannot redeem on another customer's order`
- [ ] **Step 2: Run** `npx jest accounting/tests/loyalty.redeem.test.js` → FAIL
- [ ] **Step 3: Implement** `redeemQuote` and `redeem`
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(loyalty): pay up to 20% of an invoice with points`

### Task 5: Expiry, no points, cancellation

**Files:**
- Modify: `accounting/services/loyalty/index.js`
- Test: `accounting/tests/loyalty.expire.test.js`

**Interfaces:**
- Produces: `expireDue({ session, now }): Promise<{ expired: number }>`; `settleOrders({ session }): Promise<void>`; `setNoPoints(orderId, { enabled: boolean, reason: string }, { session, req }): Promise<void>` (reason required when enabling; writes `order.loyalty`).

Expiry: each lot past `expiresAt` with `remaining > 0` → `kind: 'expire'`, `eventKey: LOYALTY_EXPIRE:<lotId>`, `remaining = 0`; entry Dr `loyalty_points` / Cr `loyalty_expense`. Take-back (order `noPoints` or cancelled, its earn lot with `remaining > 0`): same entry, `kind: 'revoke'`, `eventKey: LOYALTY_REVOKE:<lotId>`, only `remaining`. Cancelled order with redemptions: `reverseEntry` each redemption entry (`eventKey: LOYALTY_RESTORE:<redeemId>`) and add one `restore` lot per source with that source lot's `expiresAt` (a source already expired is not restored).

- [ ] **Step 1: Write the failing tests**
  - `a lot expires 365 days after it was earned, not a day before`
  - `expired points leave the balance and post liability → expense`
  - `marking an order noPoints takes back only its unspent points; the balance never goes negative`
  - `enabling noPoints without a reason is rejected`
  - `cancelling an order paid partly with points gives the points back with their original expiry`
  - `running expireDue and settleOrders twice changes nothing the second time`
- [ ] **Step 2: Run** `npx jest accounting/tests/loyalty.expire.test.js` → FAIL
- [ ] **Step 3: Implement** `expireDue`, `settleOrders`, `setNoPoints`
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(loyalty): expiry, no-points orders and cancellation`

### Task 6: Staff adjustments, customer list, history

**Files:**
- Modify: `accounting/services/loyalty/index.js`
- Test: `accounting/tests/loyalty.staff.test.js`

**Interfaces:**
- Produces:
  - `adjust({ userId, points, reason }, { session, req }): Promise<void>` — `points` positive adds a lot (`kind: 'add'`, expires 365 days later), negative deducts oldest-first (`kind: 'deduct'`); reason required; deducting more than the balance is rejected. Office for the entry: the office serving the customer's city (`pricingConfig.offices[].cities`), else `tripoli`. `eventKey: LOYALTY_ADJUST:<new ObjectId>`.
  - `customersWithPoints({ search?, sort?: 'balance'|'expiring', expiringOnly?: boolean, page, limit }): Promise<{ totals: { points, usd, customers }, rows: { userId, name, customerId, phone, points, usd, expiringSoon, lastMovementAt }[], total }>`
  - `historyOf(userId, { page, limit }): Promise<{ rows: { kind, points, orderId, orderNumber, reason, createdAt, expiresAt }[], total }>`

- [ ] **Step 1: Write the failing tests**
  - `adding 500 points with a reason raises the balance and expires in 365 days; without a reason is rejected`
  - `deducting takes the oldest first and cannot go below zero`
  - `customersWithPoints totals equal the loyalty_points account balance in cents`
  - `search finds a customer by customerId and phone; expiringOnly keeps only those with points expiring in 30 days`
  - `historyOf lists newest first with the order number and the reason`
- [ ] **Step 2: Run** `npx jest accounting/tests/loyalty.staff.test.js` → FAIL
- [ ] **Step 3: Implement** `adjust`, `customersWithPoints`, `historyOf`
- [ ] **Step 4: Run** → PASS, then `npm test` → whole suite PASS
- [ ] **Step 5: Commit** `feat(loyalty): staff adjustments, customers list and history`

### Task 7: Hourly job and API routes

**Files:**
- Modify: `accounting/index.js` (in `tick`, before `runAndStore`: `awardDue`, `expireDue`, `settleOrders`, each in its own `runInTransaction` and try/catch logging `[accounting] loyalty:`)
- Create: `controllers/loyalty.js`, `routes/loyalty.js`; Modify: `app.js` (mount)
- Test: `accounting/tests/loyalty.api.test.js` (follow `accounting/tests/api.test.js`)

**Interfaces (HTTP):**
- Client (`protect, isClient`, own data only):
  - `GET /client/loyalty` → `summaryOf` + `history` (first page of `historyOf`)
  - `GET /client/loyalty/history?page=` → `historyOf`
  - `GET /client/order/:id/loyalty` → `{ ...orderLoyalty, quote: redeemQuote for the order's open claims (invoice for a purchase order, all packages for a shipment) }` — read only; the app never redeems
- Staff:
  - `GET /loyalty/customers` (`loyalty`) → `customersWithPoints`
  - `GET /user/:id/loyalty` (`loyalty` or `clients`) → `summaryOf` + `historyOf`
  - `POST /user/:id/loyalty/adjust` (`loyalty`) body `{ points, reason }`
  - `GET /order/:id/loyalty?category=&packageIds=` and `POST /order/:id/loyalty/redeem` (`loyalty` or `invoices_payments`)
  - `PUT /order/:id/loyalty/no-points` (`loyalty`) body `{ enabled, reason }`

- [ ] **Step 1: Write the failing tests**: a client sees only their own points and orders; staff redeeming over the cap get 400 with the Arabic message; a client gets 403 on every staff route (redeem included); staff without `loyalty` get 403 on adjust
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** controllers (writes inside `runInTransaction`) and routes
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(loyalty): hourly job and API`

### Task 8: Admin — points in the order page

**Files:**
- Create: `exios-admin/src/containers/EditInvoice/OrderPointsDialog.tsx`
- Modify: `exios-admin/src/containers/EditInvoice/OrderPayments.tsx` (a "Use points" button beside each "Pay from wallet", same `category`/`packages`/`dueUsd`; a line "Points paid: N ($X)" in each section when used)
- Modify: `exios-admin/src/containers/EditInvoice/OrderWalletDialog.tsx` (when the customer has usable points: a hint "Customer has N points ($X); up to $Y can be paid with points" with a link that opens the points dialog)
- Modify: `exios-admin/src/components/InvoiceForm/InvoiceForm.tsx` ("No loyalty points" switch with a required reason, saved with `PUT /order/:id/loyalty/no-points`; shows who set it and when)

Dialog content, in order: Amount due; Customer points `N` (= $X); Max usable (20%) `M` points; number input capped at `M` with "Max" and "Clear"; summary rows Total / Points discount (−$) / Remaining to pay; "Confirm" disabled at 0 or over `M`. After success it refreshes payments and offers "Pay the rest from wallet" (opens `OrderWalletDialog` with the new due).

- [ ] **Step 1:** Implement the dialog, the buttons, the wallet hint and the switch
- [ ] **Step 2: Verify** `npx tsc --noEmit -p .` (exios-admin) shows no new errors; on a QA order: the input refuses more than `M`, the summary updates while typing, the switch cannot be saved without a reason
- [ ] **Step 3: Commit** `feat(loyalty): pay with points and no-points switch in the order page`

### Task 9: Admin — customers with points and customer profile

**Files:**
- Create: `exios-admin/src/containers/Loyalty/LoyaltyCustomers.tsx` (route `/loyalty`, sidebar item "Loyalty points" in `components/Sidebar/routes.tsx`, permission `loyalty`)
- Create: `exios-admin/src/containers/UserDetails/LoyaltyTab.tsx`; Modify: `exios-admin/src/containers/UserDetails/UserDetails.tsx` (tab "Points", and the balance `N pts ($X)` in the header)
- Create: `exios-admin/src/containers/UserDetails/AdjustPointsDialog.tsx`

`LoyaltyCustomers`: totals strip (customers, points outstanding, $ value); search box (name, code, phone); sort (balance, expiring); "Expiring in 30 days" filter; table columns Customer, Code, Phone, Points, $, Expiring soon, Last movement; row opens the customer's Points tab. `LoyaltyTab`: balance and $, expiring soon, pending list with order links and what each waits for, history table (kind, points ±, order link, reason, date, expires), "Adjust points" (needs `loyalty`). `AdjustPointsDialog`: Add/Deduct, points, required reason, the new balance preview.

- [ ] **Step 1:** Implement the page, the tab and the dialog
- [ ] **Step 2: Verify** `npx tsc --noEmit -p .` shows no new errors; on QA: search by phone finds the customer, adjusting without a reason is blocked, the header balance updates after an adjustment
- [ ] **Step 3: Commit** `feat(loyalty): customers with points page and customer points tab`

### Task 10: Client — the points section and terms

**Files:**
- Modify: `Exios-Client/src/api/index.ts` (`getLoyalty()`, `getLoyaltyHistory(page)`, `getOrderLoyalty(id)`; no redeem call)
- Create: `Exios-Client/src/containers/PointsPage/loyaltyTypes.ts` (the response types of Task 7's client routes, shared with Task 11)
- Create: `Exios-Client/src/containers/PointsPage/PointsPage.tsx`, `pointsTerms.ts` (the terms copy verbatim from the spec, as data: sections with title and lines), `points.css`
- Modify: `Exios-Client/src/App.tsx` (route `/points`), `Exios-Client/src/components/PrivateRoute/routes.tsx` (sidebar "نقاطي"), `Exios-Client/src/components/SeoManager/SeoManager.tsx` (title)
- Create: `Exios-Client/src/containers/Home/PointsCard.tsx`; Modify: `Home.tsx` (card under the stats, links to `/points`)

`PointsPage`, top to bottom: balance (points, and "= $X"); expiring soon ("تنتهي N نقطة في <date>") when any; "نقاط في الطريق" list (order link, points, "بانتظار الدفع"/"بانتظار التسليم"); "كيف تكسب النقاط" (the rates table and one example per line); "السجل" (earned, used, expired, added, deducted with reason; order links; load more); "كيف تستعمل نقاطك" (20%, example $200 → $40); "الشروط" (all sections of `pointsTerms.ts`, collapsible). Empty state for a customer with no points: what they will earn on their next shipment and a link to start shipping.

- [ ] **Step 1:** Implement the API calls, the page, the terms data, the route, the sidebar entry and the home card
- [ ] **Step 2: Verify** `npx tsc --noEmit -p .` shows no new errors; against the local API: balance, pending and history match `GET /client/loyalty`; the terms show every section of the spec
- [ ] **Step 3: Commit** `feat(loyalty): points section with terms in the app`

### Task 11: Client — the order's points (read only)

**Files:**
- Create: `Exios-Client/src/containers/OrderInfoPage/OrderPoints.tsx`
- Modify: `Exios-Client/src/containers/OrderInfoPage/OrderInfoPage.tsx` (render it in the details card)

`OrderPoints`, from `getOrderLoyalty(id)`: "نقاط هذه الطلبية": earned N, or "N نقطة في الطريق" with بانتظار الدفع/بانتظار التسليم, or the no-points reason; points already used on it; and when something is owed and `quote.maxPoints > 0`: "يمكنك دفع حتى M نقطة ($X) من هذه الفاتورة بنقاطك. اطلب ذلك من الموظف عند الاستلام أو الدفع." with a link to `/points`. No input, no button that redeems. Renders nothing while loading or if the request fails.

- [ ] **Step 1:** Implement `OrderPoints` and render it
- [ ] **Step 2: Verify** `npx tsc --noEmit -p .` shows no new errors; the component has no call that writes
- [ ] **Step 3: Commit** `feat(loyalty): show the order's points and what can be used`
