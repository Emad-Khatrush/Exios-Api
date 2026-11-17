# Loyalty points: design

Owner decisions, 2026-11-16. Customers earn points on what they pay for and can pay part of a later
invoice with them. Staff manage points fully from the admin; customers have a full points section
in the app with clear terms.

## Value
- 100 points = $1. One point is one cent, so points and cents are the same integer.

## Earning
| Claim | Rate | In cents |
|---|---|---|
| Shipping (a package's shipping charge, claim `SHP:order:package`) | 10 points per $20 | `floor(cents / 200)` |
| Purchase invoice, SWIFT included (claim `PUR:order`, order `isRemittance` false) | 10 points per $20 | `floor(cents / 200)` |
| Alipay transfer (claim `PUR:order`, order `isRemittance` true) | 5 points per $20 | `floor(cents / 400)` |

- Proportional, rounded down to whole points: $30 shipping → 15 points, $30 Alipay → 7 points.
- Purchase points are on the customer's whole purchase invoice (the `PUR` claim's billed amount).
- Earned once a claim is fully paid; a shipping claim also needs its package delivered
  (`status.received`). Not earned on a cancelled order. Added within an hour (hourly job).
- Earned once per claim: a later reprice does not earn again.
- Earned on what the customer paid in money: billed amount minus the part paid with points.
- A package's transport and customs fees (`:DOM`, `:CUS` claims) earn nothing; free-shipping
  packages bill 0 and earn nothing.
- Staff can mark an order "no points" with a required reason (e.g. a compensation invoice). It
  then earns nothing, and points it already earned and not yet spent are taken back.

## Points on the way (pending)
Eligible claims not yet earned (order not cancelled, not "no points") show the points they will
earn, `earnPoints(billed − redeemed on the claim)`, with what they wait for: "بانتظار الدفع"
(still owed) or "بانتظار التسليم" (paid, package not delivered).

## Redeeming
- Points pay at most 20% of an invoice (shipping, purchase or transfer): at most
  `floor(billed cents × 0.2)` points over the claims paid, less points already used on them, and never
  more than is still owed or than the customer has. No minimum: 1 point and up.
- Can be used in several goes on the same invoice while the total stays within 20%.
- Only staff redeem (owner's decision 2026-11-16): the customer asks at pickup or when paying, and
  staff use the points from the order's payment sections in the admin, before taking the rest by
  wallet or cash. The app never redeems; it shows how many points the customer can use on each
  invoice and tells them to ask the staff.
- The staff screen shows: the amount due, the points available and their dollar value, the most
  that can be used, and after choosing: total, points discount, remaining to pay.
- Points are a payment method, not a discount: the invoice and its revenue stay the same.
  Points never go into the wallet (the wallet is real, reconciled money).
- Staff can cancel a use of points on an order (used by mistake, the customer asked, the invoice
  changed) with a required reason (`loyalty` or `invoices_payments`): the whole redemption is
  undone (every claim it paid is owed again), the points come back with their original expiry
  (already expired: back and expired at once), and the order's payments show who used and who
  cancelled them. Any money paid alongside stays as it is. Once only.

## Expiry
- Each batch of points expires 365 days after it was earned (or added) and is not given back.
- Spending uses the oldest points first.
- Points expiring within 30 days are shown to the customer with the date.

## Staff management (admin)
- **Customers with points** page: every customer with a balance or history; search by name,
  customer code or phone; sort by balance; filter "expiring within 30 days"; totals at the top
  (points outstanding and their dollar value = the liability).
- **Customer points** (a tab in the customer's page, and the balance shown in its header): balance
  and dollars, expiring soon, pending, full history with links to orders, and manual adjustment.
- **Manual adjustment**: add or deduct points with a required reason, shown to the customer in
  their history. Added points expire 365 days after adding. Deducting takes the oldest points first
  and never goes below zero.
- **No points** switch with reason on the order.
- Permission: a new staff permission `loyalty` for the page, adjustments and the switch; redeeming
  on an order also allowed with `invoices_payments`.

## Customer app
- A **نقاطي** section (sidebar entry and a card on the home page linking to it):
  balance in points and dollars; expiring soon; points on the way with what each waits for; how to
  earn (the rates table with examples); history (earned, used, expired, adjusted) with links to
  orders; how to use; the full terms below.
- The order page shows points earned (or on the way) for that order, or why it earns none; and when
  something is owed and `maxPoints > 0`, a read-only note: "يمكنك دفع حتى M نقطة ($X) من هذه
  الفاتورة بنقاطك. اطلب ذلك من الموظف عند الاستلام أو الدفع." No redeem button in the app.

## Terms (customer copy, Arabic, shown in full in the app)

**ما هي النقاط؟** مكافأة على تعاملك معنا. كل 100 نقطة تساوي 1 دولار، تستعملها لدفع جزء من فواتيرك القادمة.

**كيف تكسب النقاط؟**
- الشحن: 10 نقاط عن كل 20 دولار من قيمة الشحن.
- فواتير الشراء وحوالات سويفت: 10 نقاط عن كل 20 دولار من إجمالي الفاتورة.
- حوالات علي باي: 5 نقاط عن كل 20 دولار.
- تُحسب بالنسبة وتُقرَّب للأقل: شحن بـ 30 دولار = 15 نقطة.

**متى تُضاف؟**
- فاتورة الشراء أو الحوالة: بعد دفعها كاملة.
- الشحن: بعد دفع الطرد كاملاً واستلامه.
- تُضاف خلال ساعة، وحتى ذلك الحين تظهر في «نقاط في الطريق».

**ما الذي لا يكسب نقاطاً؟**
- رسوم النقل الداخلي ورسوم التخليص الجمركي.
- الطرود المشحونة مجاناً ضمن العروض.
- الجزء الذي دفعته بالنقاط.
- الطلبيات الملغاة.
- فواتير التعويض أو أي فاتورة يستثنيها المكتب، ويظهر لك السبب.

**كيف تستعمل النقاط؟**
- على أي فاتورة شحن أو شراء أو حوالة عليها مبلغ مستحق.
- اطلب استعمالها من موظف المكتب عند استلام شحنتك أو دفع فاتورتك، وهو يخصمها لك. في صفحة كل طلبية ترى كم نقطة يمكنك استعمالها عليها.
- حتى 20% من قيمة الفاتورة. مثال: فاتورة 200 دولار، تدفع حتى 40 دولار (4000 نقطة) بالنقاط والباقي بالطريقة المعتادة.
- يمكن استعمالها على دفعات في نفس الفاتورة ما دام المجموع لا يتجاوز 20%.
- تُستعمل النقاط الأقدم أولاً.

**صلاحية النقاط**
- كل دفعة نقاط صالحة لمدة سنة (365 يوماً) من تاريخ إضافتها.
- النقاط المنتهية لا تُرجع. ننبهك في التطبيق قبل انتهائها بـ 30 يوماً.

**الإلغاء والاسترجاع**
- إذا أُلغيت طلبية دفعت جزءاً منها بالنقاط، تعود النقاط لرصيدك بتاريخ انتهائها الأصلي.
- إذا أُلغيت طلبية كسبت منها نقاطاً، تُسحب منها النقاط التي لم تستعملها بعد.
- إذا استُرد لك مبلغ فاتورة، يحق للمكتب خصم النقاط التي كسبتها منها.
- تعديل مبلغ فاتورة بعد إضافة نقاطها لا يغيّر نقاطها.

**النقاط ليست نقوداً**
- لا تُسحب نقداً، ولا تُحوَّل إلى المحفظة، ولا تُنقل إلى عميل آخر.
- تسقط النقاط عند إغلاق الحساب.

**تعديلات المكتب**
- قد يضيف المكتب نقاطاً (مكافأة أو تعويض) أو يخصمها (تصحيح خطأ)، ويظهر السبب في سجل نقاطك.
- يحق للشركة إلغاء النقاط المكتسبة بطريقة احتيالية أو مخالفة لهذه الشروط.

**تغيير الشروط**
- قد نعدّل نسب الكسب أو هذه الشروط، ونعلن ذلك في التطبيق قبل 30 يوماً من تطبيقه. النقاط التي كسبتها قبل التعديل تبقى بقيمتها حتى انتهاء صلاحيتها.

**عندك سؤال؟** تواصل مع مكتبك، ومعك رقم الطلبية.

## Accounting (accrual)
Two new accounts, added at startup to existing databases:
- `220600` نقاط العملاء (liability, per customer: `partner`), role `loyalty_points`.
- `532000` مصروف برنامج النقاط (expense, per office: `office`), role `loyalty_expense`.

| Event | Debit | Credit |
|---|---|---|
| Earn, or staff add | loyalty_expense (office of the order, or of the customer for an adjustment) | loyalty_points (customer) |
| Redeem | loyalty_points (customer) | customer_receivable (the claims paid, `arKey` lines) |
| Expire, staff deduct, or taken back (no points / cancel) | loyalty_points (customer) | loyalty_expense |
| Cancelled order after redeeming, or staff cancel a redemption | the redemption entry is reversed (`LOYALTY_RESTORE:<id>`, or `LOYALTY_REDEEM_CANCEL:<id>` for staff); the points come back with their original expiry |
