# Historical cash analysis

Location: Accounting -> Historical cash (`/accounting/historical-cash`).
This is an independent receipts/payments report, not a general-ledger journal,
profit-and-loss statement, or a historical wallet transaction importer.
It never changes existing wallets, receivables, invoices, bank statement lines,
opening balances or ledger entries. Do not add its amounts to ordinary ledger
reports covering the same transactions.

## Unified review of normal records

The report now also reads normal asset-type cash ledger movements and bank
statement lines live, within the selected dates/offices/accounts/currencies.
These are references to their originals, not copied financial documents.
Open the source to change amounts or cancel the actual transaction. Supplier cost
documents also appear for review but do not contribute a second cash payment.
Unpaid costs, opening entries, cash-count adjustments, reversal entries and
cancelled originals do not become new cash outflows in this report.

For linked bank/ledger records, connected match groups are compared in native
minor units per account. Equal groups use the bank rows once. A partial or
inconsistent match remains flagged and uses the ledger amount once until fixed.
Matching one side of a transfer never removes the other account's cash leg.

Normal records start pending review. A reviewer with `closing` permission can
classify and mark them reviewed, flag an issue, exclude them from this report, or
link an exact existing manual movement (same account, office, date, direction,
currency and amount). A documented independent decision is required to approve
an apparently duplicate normal record independently. Review does not approve a
bank match, post a journal, alter a wallet, or cancel the source.

A valid manual link counts the manual movement once and suppresses the normal
reference's second contribution. A source edit invalidates the review. If a
linked original changes or disappears, its outdated manual copy is withheld
from totals pending correction; an unchanged live source takes over provisionally.
The approved-only filter excludes unresolved changes. Manual movement IDs survive
editing so these links can be validated. An orphan warning opens the historical
statement for correction. A later matched bank source can take over an obsolete
ledger-source link after explicit review.

The scope selector offers combined, historical-statements-only and normal-only
totals. All currencies remain separate. Date/account filters must be narrowed if
the safe review limit is exceeded; the API refuses instead of returning partial
totals. This is not automatic reconstruction of unknown old customer revenue.

## Workflow

1. Choose New statement / Import Excel, an office, and one money account.
   The account fixes currency and precision. Split different accounts/currencies
   into separate statements. Initial editable period is 2026-01-01 to 2026-04-03.
2. Enter statement opening/closing balances (available balance positive, overdraft negative).
   These are reconciliation controls only, never accounting opening entries.
3. Download the Arabic XLSX template, or upload `.xlsx`, `.xls`, or `.csv` (5 MB).
   Choose worksheet, header row, columns and the explicit number format.
   Each statement supports up to 1,000 movements. Oversized/truncated worksheets
   are rejected rather than imported partially.
4. Supported fields: date, description, amount and direction, category, receipt
   reference, internal-transfer reference. Separate incoming/outgoing amount
   columns are also supported. Excel dates and day/month/year text are supported.
   Positive signed amounts default to receipt, negative to payment when direction
   is absent. An explicit category must match the direction.
5. Convert to review rows. Edit/exclude rows, or bulk-classify compatible unknown
   rows. Unknown classifications may be saved as drafts, not approved.
6. Preview server validation and duplicate warnings. Correct errors or exclude
   duplicate rows. A verified separate transaction needs an independent reason
   of at least ten characters. Possible same-day/amount ledger entries are advisory
   references only; they are not imported or posted again.
7. Save draft. The original workbook is retained and can be downloaded through
   the protected source endpoint. Edited row versions are retained in AuditLog.
8. Review and approve. Required: all categories resolved, duplicates reviewed,
   opening + receipts - payments equals closing, internal transfers paired by a
   unique common reference. Same-currency legs must have equal amounts, opposite
   directions, different accounts and dates within seven days. Different-currency
   legs rely on the explicitly supplied common reference; this is not FX valuation.
9. Approved statements are immutable. Reopen with a documented reason before
   editing. A related approved transfer leg must also be reopened before changes
   can invalidate it. Voiding is audited, never a hard delete, and excludes the
   statement from reports.

Categories distinguish customer receipts, supplier/trip payments, operating
payments, customer refunds/withdrawals, supplier refunds, company transfers,
financing, investing, and unclassified movements. They are cash classifications,
not declarations that every receipt is revenue or every payment is an expense.
Only asset-type money accounts are eligible. Credit-card purchase statements and
other liability accounts are excluded: credit spending is not a cash payment.
Record the actual card settlement on the paying bank's statement, classified
according to its substance, without importing card purchases again as cash outflows.

## Statement scope

Every statement has an explicit scope. Existing statements default to `full`.
`full` requires opening plus receipts minus payments to equal closing before
approval. `wallets` is a partial historical customer-movement review, not a cash
account reconciliation. It accepts only customer receipts, customer withdrawals /
refunds, or unknown rows awaiting classification. Unknown rows cannot be approved.
Approval still rechecks errors, duplicates, permissions, revision and audit reason;
it does not require opening or closing balances and returns no reconciliation
difference. Previously entered treasury balances are retained as reference only.
The type can be changed only by saving an editable draft with a new preview;
approved statements require reopening first. Approval uses the stored type, not
a type supplied in the approval request. Both scopes feed movement totals and
share the same duplicate detection; wallet-only approval is not evidence that
the whole treasury is reconciled. No current wallets or ledger entries change.

## Report totals

Date/office/account filters and approved-only selection apply to the report.
Monthly totals use movement dates, not the workbook filename or import date.
Different currencies are never added together or silently converted.
The report shows gross receipts/payments, company transfers separately, and net
cash movement excluding those transfers. Drafts and unresolved categories remain
visible and provisional. Transfers with no valid counterpart cannot be approved;
draft report totals must not be treated as reconciled company totals.

Excel export includes monthly details, category totals, scope totals per currency
and a scope/status sheet stating that it is not profit/loss. Pagination applies
to the statement list only; report totals/export cover all matching movements.

## Access, isolation and integrity

- Read, options and original source: `reports` or `treasury` permission.
- Create/preview/edit/void draft: `treasury`.
- Approve/reopen: `closing`. Existing owner bypass rules apply.
- Dedicated `AccountingHistoricalCashBatch` and `AccountingHistoricalCashMutex`
  collections. No posting service, cash count, migration or wallet API is invoked.
- A historical-only mutex serializes commits and reviews; request keys make
  retries idempotent. Preview fingerprints and revisions reject stale changes.
- Historical approval is independent of the general-ledger financial-period lock.
  It does not approve the financial statements or establish IFRS compliance.
- There is no automatic conversion to journal entries. A later accounting
  reconstruction needs a separately reviewed implementation and duplication checks.

## Validation

Backend `historicalCash.test.js`: lifecycle/source preservation and financial
isolation, validation/LYD precision, duplicates and independent decisions, stale
previews/edits, paired transfers, monthly filters/currencies, concurrent retries,
and HTTP read/write/review/source access with multipart uploads.
Frontend tests cover real XLSX reading, Arabic digits, explicit locale/date
handling, conflicting receipt/payment columns, report currencies, entry controls
and disabling approval of unsaved changes. Browser acceptance uses an isolated
MongoDB replica set with the real API, Excel upload, preview, save, approval,
reporting and export; no company data is used.

`historicalCashSources.test.js` verifies live references, bank/ledger connected
match deduplication, both transfer cash legs, exact manual links, source edits and
cancellations, stable manual row IDs, unpaid noncash costs, partial-match review
and link rejection, later bank source handover, and native foreign amounts.
Browser acceptance also links an imported historical expense to its ordinary
posted source, checks totals count once and verifies review adds no ledger entry.
