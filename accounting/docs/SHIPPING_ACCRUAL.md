# Live shipping recognition and trip cost review

## Posting policy

All live delivery paths now use the same policy, whether paid in full, partly
paid, or unpaid. A delivered package earns its full shipping/transport/customs
charge, with the remaining customer receivable left open. Later collection only
settles the receivable. Payment ratio does not determine revenue or the cost share.

The delivered package's full recorded share of international/domestic trip cost
is transferred out of trip work in progress, using the existing chargeable-weight
allocation. Shares of undelivered packages stay in progress. A late carrier bill
recalculates these shares without duplicating the existing cost. Returning a
package to undelivered reverses its recognition; cancellation does not erase the
carrier's bill or obligation. Free shipping has no shipping revenue and its cost
is charged to the purchase order where applicable, once delivered.

This change does not turn administrative costs into trip WIP. General expenses
must continue to use their expense-account target; only direct trip costs should
use a trip target. It does not introduce automated percentage-of-completion,
change write-off accounting, or assert universal IFRS compliance. The accountant
must assess the contract's performance obligations, recognition timing, and any
required month-end progress/accrual entries. Neither elapsed days nor cash
receipts provide an automatic completion percentage.

## Historical records

Historical replay retains its original policy until a dated transition is present.
Each live recognition records `shippingRecognitionFrom` so a future replay knows
the effective day. Closed periods shift recognition into the first open day.
Existing journals are preserved.

No bulk settlement runs during deployment or by opening a report. Existing
delivered packages can be reviewed under Accounting -> Reports -> Trip profitability
-> Review old deliveries. Preview now includes cost-only differences, not only
remaining deferred revenue. The owner selects at most 100 orders and reviews the
effect before applying. Stale snapshots are rejected; concurrent applications
cannot post the same correction twice.

Applying that review reconciles only the delivered shipping revenue/cost. It does
not recalculate purchase invoice recognition, change invoice amounts, move cash
or customer wallet balances, or create a new receivable. Normal subsequent live
syncs also bring touched legacy packages onto the same live policy.

## Review and presentation

The trip accounting panel shows profit as provisional until costs have a current
completion certificate and all active packages are delivered with no cost left
in progress. New/edited cost documents or ledger changes invalidate the existing
cost-review fingerprint. A link opens the existing accounting review queue.
This is trip cost review, not approval of the company's entire financial period.

At a past month end, the queue also includes WIP carried from previous months,
even if that month had no new shipping sale. Missing cost certification remains
a blocker under the existing approval rules. A separate informational progress
reminder asks the accountant to review service completion and accrued costs; it
does not generate an estimated recognition entry or certify IFRS compliance.

## Validation

`shippingAccrual.test.js` exercises partial/full/no collection, full weight-based
cost shares, late bills, undelivery/cancellation, free offers, legacy preview and
cost-only correction, purchase/wallet/receivable isolation, concurrent retries,
closed periods, replay effective dates, review invalidation, carried month-end
WIP, and domestic/customs charges. Each test also checks that every journal is
balanced.

Related regression checks: `purchaseAccrual.test.js`, `phase3.test.js`, and
`accountingReview.test.js`. Two pre-existing failures were reproduced with the
original files: phase 3 scenario 4 expects a LYD FX line on account 710100;
accounting review's multiple-bank-candidates fixture is rejected by existing
duplicate-cost protection before bank matching. Those are not relaxed by this
change.
