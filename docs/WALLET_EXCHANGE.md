# Customer wallet exchange

Implemented on `master`. The accounting branch is not merged or modified.

## User flow

Client profile → **صرافة داخل المحفظة**. Select the source USD/LYD wallet,
enter its amount, the rate in **LYD per USD**, and the operation date.
Review both amounts and confirm. USD → LYD multiplies by the rate; LYD → USD
divides by it. The operation moves no bank, cash, order payment or customer debt.

Alternatively enter **المبلغ بعد الصرافة**. The rate is then calculated from the
two amounts in either direction. Editing the rate switches back to rate-based
calculation; editing the received amount switches to received-amount calculation.
Changing the source amount preserves the chosen calculation method.

Example: 100 USD at 9.5 becomes 950 LYD. The reverse uses the same rate, 9.5.
Wallet amounts have two decimal places; rates allow six. Conversion uses integer
arithmetic with rounding to the nearest cent, with halves rounded up.

## API and records

- `POST /api/wallet/:customerId/exchange/quote`: `{fromCurrency, amount, rate}`,
  or `{fromCurrency, amount, toAmount, pricingMode: "received"}`.
- `POST /api/wallet/:customerId/exchange`: the same fields plus
  `{day: "YYYY-MM-DD", note?, idempotencyKey}`. Only staff roles can use it.
- One `WalletExchange` stores both native amounts, direction, rate, effective
  date, pricing mode, actual creation timestamp, actor and the two statement identifiers.
- In received-amount mode the exact two amounts are authoritative. The derived
  rate is displayed/stored at six decimals; it is never multiplied back into the
  source amount to replace the chosen received amount. Idempotency compares both
  native amounts, including when different amounts yield the same rounded rate.
- Two `UserStatement` rows use `actionType: exchange`, `paymentType: wallet`,
  `walletExchangeId`, `walletExchangeLeg`, and a shared accounting source.
- USD and LYD cashflow summaries classify exchanges separately from cash,
  refunds, order/debt spending and withdrawals.
- A MongoDB transaction changes both wallets, creates both statements and the
  exchange, and, when enabled, posts accounting. A failure rolls everything back.
- Customer-level transaction contention and a conditional source deduction
  serialize simultaneous conversions. A unique customer/request key prevents
  repeat submissions. Reusing a key for different inputs returns 409.
- Insufficient funds, invalid/zero amounts, invalid rates, duplicate wallets,
  future dates and invalid calendar dates are rejected. Neither exchange leg can
  be individually edited/deleted through the statement actions.
- A source wallet without a statement history retains its existing opening
  balance. Backdating changes effective ordering without changing insertion-based
  stored totals or the actual current wallet balance.

## Accounting integration at the approved merge

`utils/walletExchangeAccounting.js` is dormant while accounting is absent.
Do not copy the entire accounting branch onto master to activate it.

When accounting is approved and merged, retain the exchange-specific schema
fields and the `exchange` enum value, as well as accounting's existing source
and dynamic-office fields. Then run:

```sh
node scripts/integrateWalletExchangeAccounting.js --apply
```

This installs the two-line dispatch described by
`docs/WALLET_EXCHANGE_ACCOUNTING.patch` **before** the generic statement source
skip in `accounting/services/posting/operations.js`. It is idempotent and refuses
an unknown entry-point layout. This step is required: merely merging a folder
does not install the historical/outbox dispatch. Run it and the compatibility
tests before turning on accounting or historical migration.

The adapter posts one `TRANSFER` journal under
`WALLET_EXCHANGE:<exchangeId>`, with source model `WalletExchange`:

1. Debit the source customer-wallet liability (`wallet_usd` / `wallet_lyd`).
2. Credit the destination customer-wallet liability.
3. Value the source using its carrying value and the destination using the
   accounting date's rate. Post any difference to the configured realized FX
   gain/loss role. The customer's quoted rate determines native amounts; it does
   not overwrite the company's daily accounting rate.

Currency precision is converted at the adapter boundary. A three-decimal LYD
accounting configuration still receives 950 LYD when the wallet stores 950.00.
No cash account is included. Both rows carry the customer dimension.
Accounting period locks and missing required accounting rates reject and roll
back a live conversion.

Before live posting, exchanges retain their operational data without posting.
Historical replay already traverses their two statements; the installed hook
posts the paired exchange exactly once and records `migrationRunId`, so
discard/replay uses the existing migration cleanup. Dry runs do not mark the
operational exchange as permanently posted. The historical journal is the
authority after commit; the document's `posting` marker is updated by live posting.
The same hook handles subsequent outbox retries without additional journal entries.

## Validation

```sh
npm run test:wallet-exchange
```

Fourteen master tests cover both directions, exact rounding, malformed input,
authorization, insufficient funds, duplicate wallets, backdating, rollback,
concurrency, idempotency and a concurrent legacy withdrawal using a stale balance.
The legacy withdrawal now refuses that stale snapshot instead of overwriting
the conversion's balance. The accounting checks are enabled when the full
accounting subsystem is present and its dispatch hook has been installed.

Four additional checks were run in a detached, isolated checkout of
`feature/accounting` with the new feature and hook applied: live FX gain/loss,
one journal across statement/outbox retries, closed-period rollback, and
historical posting without committing the dry-run marker. All database tests
use temporary MongoDB replica sets, never a company database.

The new UI was checked on desktop and mobile against an isolated in-memory API.
No push, deployment, branch merge or company balance migration is part of this change.
