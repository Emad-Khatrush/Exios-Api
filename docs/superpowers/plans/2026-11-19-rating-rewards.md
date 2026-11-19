# Rating Rewards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 3 points per order rated within 30 days, one rating for every received unrated order, a home card, a `/rate` page and a reminder push.

**Architecture:** A `ratings` service in Exios-Api (`accounting/services/loyalty/ratings.js`) decides what awaits rating, saves ratings and grants points through `grantGift`; new client routes and the old order route call it; the hourly loyalty jobs remind. The client adds a `/rate` page, a home card and the points line on the order page.

**Tech Stack:** Node/Express/Mongoose + Jest (Exios-Api); React 18 + TypeScript + Jest (Exios-Client). Branch `client-update`.

**Spec:** `Exios-Api/docs/superpowers/specs/2026-11-19-rating-rewards-design.md`

## Global Constraints

- `POINTS_EACH = 3`, `DAYS = 30`, eventKey `RATING:<orderId>`, reason «مكافأة تقييم الخدمة».
- Only the customer's own, non-cancelled orders created on/after `LOYALTY_START_DATE`.
- Questions are the order page's three (`employeeQuestion`, `generalQuestion` ratings 1–5, `reviewQuestion` text).

## Review Focus

- An order with two packages, one received → awaits rating (delivered at that package's date).
- A rating posted twice in parallel for the same orders → one rating and 3 points per order (unique eventKey + existing-rating check in the transaction).
- Another customer's order id in `orderIds` → skipped silently, the rest rated.
- The old order-page route with another customer's order → 404, nothing saved.
- A customer with points off → rating saved, no points, no error.

---

### Task 1: The ratings service and routes (Exios-Api)

**Files:** Create `accounting/services/loyalty/ratings.js`; Modify `controllers/orders.js` (`createRatingForOrder`), `routes/orders.js` (two client routes), `models/order.js` (`ratingRemindedAt`); Test `accounting/tests/ratings.rewards.test.js`.

**Interfaces (Produces):** `pendingFor(userId, { now }) → Order-like rows`; `rate({ userId, orderIds, questions }, { now }) → { rated, points }`; `remindDue({ now }) → { reminded }`; constants `POINTS_EACH`, `DAYS`.

- [ ] Failing tests for the spec's Testing list (service level, `loyaltyKit` orders with received packages / bought purchases, `now` injected).
- [ ] Run `npx jest accounting/tests/ratings.rewards.test.js` → FAIL.
- [ ] Implement the service (rate inside `runInTransaction`: re-check each order, `OrderRating.create`, `grantGift` unless `isOff`), the routes, and point `createRatingForOrder` at it.
- [ ] Run the test, then `npx jest accounting/tests/loyalty --maxWorkers=10` → PASS.
- [ ] Commit `feat(loyalty): 3 points for every order rated, one rating for all`.

### Task 2: Reminder (Exios-Api)

**Files:** Modify `accounting/services/loyalty/ratings.js` (`remindDue`), `utils/customerPush.js` (`ratingReminder(userId, count)` + `ratingReminderText(count)`), `accounting/index.js` (job `ratings`); tests in the same file; update `loyalty.api.test.js` jobs expectation.

- [ ] Failing tests: one push per customer, counts in the text («استلمت 4 طلبيات… 12 نقطة»), never twice.
- [ ] Implement; run all loyalty suites → PASS. Commit `feat(loyalty): remind customers to rate what they received`.

### Task 3: Client (Exios-Client)

**Files:** Create `src/containers/RatePage/RatePage.tsx`, `rate.css`, `rateText.ts`; Modify `src/App.tsx` (`/rate`), `src/api/index.ts` (`getPendingRatings`, `rateOrders`), `src/containers/Home/Home.tsx` (card), `src/components/OrderRatingWidget/OrderRatingWidget.tsx` (points line); Test `src/__tests__/rateText.test.ts`.

- [ ] Failing test for `rateButtonText(n)` («أرسل التقييم واكسب 12 نقطة»), `ordersWord(n)` and `homeCardText(n)`.
- [ ] Implement; `npm run check` → PASS; render the page headless and look. Commit `feat(points): rate everything received at once and earn 3 points each`.
