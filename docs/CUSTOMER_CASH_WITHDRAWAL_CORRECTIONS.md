# Customer cash withdrawal corrections

Local code review and hardening: 25 October 2026. This document does not confirm deployment to QA or production.

## Screen and permission

Clients → customer profile → Cashflow statement. A cash withdrawal is an outgoing line (`calculationType: '-'`) with `actionType: 'withdrawal'` or `paymentType: 'withdrawal'`.

Admins see **Edit cash withdrawal** and **Delete cash withdrawal** actions. The earlier admin-only requirement is retained. Accounting roles without admin permission do not gain this permission. Other outgoing lines, such as order/debt wallet payments, continue to use their source documents.

The existing cashflow implementation already supports these corrections; this update makes the action labels specific and strengthens stale edit/no-op handling and funding-account preservation.

## Accounting and wallet effects

- Edit: preserve the statement identity, validate the old/new period, amount, currency and funding source; record edit history; update the customer wallet by the difference and rebuild the statement totals. Reverse the previous source entries and post the corrected withdrawal synchronously when live posting is enabled or a posted source entry already exists. A posting failure rolls back the correction.
- Delete: archive the full original statement with the admin and date, reverse the original posted entries, return the amount to the customer wallet, and rebuild statement totals inside the same transaction.
- Reversed bank matches are reopened through the existing match lifecycle, and superseded pending/failed posting events are skipped after the synchronous correction. No unrelated order payment is deleted.
- Source matters: a branch cash box or the original employee's custody is recorded explicitly. Wallet availability is checked atomically if the amount increases; custody posting checks the available employee balance after reversal of the original entry.
- If neither live posting nor a previously posted source entry is present, the update retains the system's existing deferred posting policy. It does not claim that historical accounting was initialized by editing this line.

## Safeguards added in this update

1. Edit/delete requests from the UI carry `expectedEditCount`. A changed edit-history length produces HTTP 409 and requires refreshing the statement. The optional field keeps earlier API callers compatible; admin authorization remains mandatory for every withdrawal correction.
2. Saving a dialog with no changes is disabled. The server also compares the normalized statement fields and returns without adding edit history, reversing entries, reopening matches or emitting a new accounting event when nothing changed.
3. If the office and source are unchanged and the statement records an explicit active cash account in the correct currency, editing preserves that account. A later office mapping change cannot silently move the corrected withdrawal to another account. Invalid original accounts require a valid explicit source choice.
4. Insufficient-wallet errors for increased withdrawals refer to the additional withdrawal amount rather than deposit spending.

Dates, currency and operational links are validated on the server. Documents created by Accounting, customer/supplier refunds and outgoing order payments retain their existing protections. The user interface refreshes both the wallet and the customer statement after a successful correction.
