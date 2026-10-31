# Historical opening cash valuation

`AccountingSettings.openingCashRateMethod` selects `legacy` (unchanged default),
`receipts_1m`, `receipts_2m`, `receipts_12m`, or `receipts_all`. The window ends
on the count day, inclusive. A new migration snapshots this choice in its config.
Changing settings does not change an existing run or approved journal entries.

For each foreign-currency cash account, active incoming journal lines are sampled
in the selected window. Reversed originals, reversing entries, manual entries,
opening balances, cash counts and valuation adjustments are excluded. The estimate
is total incoming currency units divided by total incoming USD, not a simple mean
of exchange rates. Transfers into the account qualify at their booked USD value.
If no usable receipts exist, the count-day rate is used and marked as a fallback.

For a new migration, counted currency / sampled rate is the target USD balance.
The opening entry corrects quantity and USD value separately. It can therefore
post a USD-only adjustment even when the quantity already matches, and can handle
opposing quantity and USD changes without violating journal sign rules. Commit
checks require the valuation adjustment's journal entry as well as quantity changes.

`GET /accounting/settings/opening-cash-valuation-preview` is setup-permission
protected and read-only. It compares the ledger balance at the count day with
the selected estimate. It does not create journals or recalculate later payments.
An approved opening and subsequent FX results require a separately reviewed
correction; saving the preference never performs it.

## Apply to a current cash balance

`GET /accounting/settings/current-cash-valuation-preview` previews the current
ledger balance at today's incoming weighted rate. `POST
/accounting/settings/current-cash-valuation-apply` applies one explicitly selected
account, with a reason, fresh preview fingerprint and idempotency key. Both require
setup permission. Preview writes no data; apply uses a transaction, the shared
period gate and cash-account mutex. A concurrent receipt, changed sample or closed
period requires a new preview. Empty samples and nonpositive balances cannot be
applied automatically; the daily fallback is not used for this action.

The `FX_REVALUATION` entry carries zero foreign amount and changes only USD value.
Its counterpart is unrealized FX gain/loss (legacy FX account if unmapped). The
posted currency quantity is checked against the preview before commit. Existing
payments and their FX entries are not rewritten, and the global daily FX rate is
not changed. Subsequent outflows use the new carrying value. Revaluation entries
are excluded from the incoming sample and have no bank-statement cash amount.

This is an estimate for historical migration data. It is not periodic closing-rate
revaluation under IAS 21. Normal live cash outflows still use the account's carrying
value; a conversion into USD records actual dollars received and the difference
as FX gain/loss. A historical opening preference does not change that policy.
