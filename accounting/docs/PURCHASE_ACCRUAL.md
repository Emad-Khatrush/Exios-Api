# Purchase invoice recognition

The existing invoice and cost inputs stay unchanged. This is the owner's requested
gross invoice/cost presentation, not a new commission field or an assertion that
every purchase contract qualifies for gross presentation under IFRS 15. An
accountant must assess principal-versus-agent treatment for the actual contracts.

## Live purchase invoices

- Purchase order status 0 (preparation): invoice remains in deferred purchase revenue;
  supplier costs stay in purchase work in progress. Receiving money, confirming the
  invoice, or adding a timeline message does not complete the purchasing service.
- Status 1 (Purchased) and later, or a finished order: recognise the full invoice
  and full recorded supplier cost, regardless of customer collection.
- Example: invoice USD 500, cost USD 400, collection USD 450 gives revenue USD 500,
  expense USD 400, accounting profit USD 100, customer receivable USD 50.
  Later collection of USD 50 settles the receivable without another sale/cost.
- The existing accounts are used: 220300 deferred purchase revenue, 410300 purchase
  invoice revenue, 130200 purchase work in progress, 510400 purchase invoice cost,
  and the existing customer receivable/payment accounts.
- A late supplier bill updates the full expense. A completed zero-price purchase
  still expenses its real cost and displays the loss in the order summary.
- Reverting to preparation reverses recognition into deferral/WIP. Cancellation
  follows existing cancellation/refund rules; it does not erase supplier obligations.
- Existing write-off/refund rules continue to apply; this change does not revise
  their treatment or remittance policy.

## History and rollout

Historical replay (`isHistorical`) and Alipay remittance invoices retain their
existing payment-based policy. No bulk correction or live data mutation runs as
part of this code change. A later live sync of an existing purchase evaluates its
current status and posts only the recognition difference, using the existing
posting-date/period guards. Original entries are not rewritten. Before deployment,
review legacy purchase statuses and the effect on old partially paid orders.

The status gate uses the structured purchase workflow, not arbitrary activity text.
Repeated syncs post no duplicate recognition. UI copy explains accounting profit
versus cash collected.

## Validation

`accounting/tests/purchaseAccrual.test.js` covers partial/full/no collection,
purchase completion, late costs, reversal/cancellation, zero-price losses,
historical replay and forward adjustment, idempotency, and remittance isolation.
The existing phase 3 full-payment purchase test now explicitly marks the service
Purchased, rather than treating payment as service completion.

Verified 2026-10-28: all 6 new integration tests pass; 15 of 16 phase 3 tests
pass. The remaining phase 3 scenario 4 (LYD exchange gain expecting account
710100) also fails against the original unmodified sync implementation and is
not caused by this change. Legacy purchase approval (8 tests), report findings
(7 tests), frontend TypeScript and whitespace checks pass.
