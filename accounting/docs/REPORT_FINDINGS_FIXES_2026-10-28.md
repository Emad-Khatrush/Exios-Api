# Test report findings addressed — 2026-10-28

Scope: findings F-01, F-02 and F-03 from the October 25 accounting test report, plus clearer handling of the F-07 canceled-order cost review. Existing uncommitted work was preserved.

Explicitly excluded by the owner: insufficient-cash expense policy, batch-payment eligibility policy, and completion of unavailable/partial PayCash and background-failure test paths. Those policies and paths are unchanged.

## F-01: write-offs are not payment

Order claims now report `writtenOff` separately. Their paid amount subtracts net active write-offs; later recoveries reduce that net write-off and count the actual payment. Reversed write-offs no longer count. Customer invoice listings retain the original claim value and show `written_off` rather than claiming the invoice was paid. Order and invoice views have separate write-off columns/summary values.

Exact order-debt links are enriched with an accounting-write-off annotation, without changing debt balances, closing a reminder, or disabling later collection. Old reminders that cannot be mapped to a specific package show only an order-level warning. Lost-debt amounts no longer appear as paid simply because the debt is outside the open tab.

## F-02: derived loss coverage

The derived `lost` balance is covered only if its owner, currency, original amount, parent link and the parent's `manualClosure.lostBalance` agree, the parent is closed, its `balanceWriteOff` event is completed/covered, and an active `DEBT_WRITEOFF` journal exists for that parent. A failed event, missing journal, reversed journal, or invalid link remains an exception. The check creates no financial entries.

## F-03: manual suspense items

Ordinary manual entries on the suspense account are included. Settlement-generated entries, reversals and historical closing entries stay excluded. The UI separately shows the ledger balance and warns of any unexplained difference from the open-item list when no date range is applied. Existing settlement, reversal and period-lock behavior is retained. A transaction version on the original journal serializes competing settlement requests, preventing duplicate settlements from simultaneous clicks.

## F-07: canceled-order supplier costs

These costs are not automatically deleted or written off. A canceled-order accounting panel now explains and links the supported routes: actual supplier refund, supplier credit note, or documented reclassification. The original report's 75 USD was test-data evidence, not authorization to erase a real supplier obligation or assume a refund. No company-data settlement was posted by this change.

## Verification

`accounting/tests/reportFindings.test.js` covers complete/partial write-offs, later recovery, reversed write-offs, linked debt annotations, manual suspense visibility, settlement and reversal, competing settlement requests, and strict derived-loss coverage. The existing migration/suspense regression suite and actual delivered-package write-off/recovery scenario were also run. Frontend tests verify that lost/written-off debt amounts are not reported as paid.
