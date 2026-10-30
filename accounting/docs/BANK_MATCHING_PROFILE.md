# Portable bank matching profile

`accounting/seed/bankMatchingProfile.json` is the versioned matching configuration
shipped with the API. It contains account-code signatures, merchant definitions
and aliases, learned merchant/account mappings, keyword rules, and exact normalized
description hints extracted using the same latest-500-per-account history window
as the bank classifier. It contains no balances, journal entries, invoice IDs,
statement amounts, credentials or local database object references.

## Refresh from Local

Run `node accounting/scripts/bankMatchingProfile.js export` against the configured
loopback Local database. Export is read-only and replaces the JSON file. Review
and commit the updated file along with API code when a deployment is requested.
The file can contain real supplier names and normalized bank descriptions: it is
business configuration for the private application repository, not a public asset.

## Deploy

After ordinary accounting setup and merchant setup, API initialization attempts
to apply the packaged profile. Codes resolve to the target database's own IDs.
Required accounts must already exist, be active/detail accounts and have matching
type, currency, cash flag and office. Unknown offices, ambiguous vendors,
different existing rules or another vendor owning a learned mapping block the
whole profile transaction. No partial changes or automatic replacement of target
choices occurs. A failure is logged as `bank matching profile NOT applied`; the
application keeps its existing configuration and continues starting.

Successful profile hashes are recorded once with an audit event. Subsequent
restarts preserve operator changes instead of replaying the same package. A
changed package is checked again, with existing choices protected.

Manual commands on a target environment:

```
node accounting/scripts/bankMatchingProfile.js check
node accounting/scripts/bankMatchingProfile.js apply
```

`check` validates and reports the plan without applying it. `apply` is atomic.
Connections use the application's configured `MONGO_URL_2` / `MONGO_URL`; commands
do not print connection strings. Neither command creates financial movements.

## Matching limits

Imported exact-description hints only supplement missing live history. New
approved history takes precedence; matching engine preferences remain in force.
Hints classify proposals, never prove that a payment already exists. Real
automatic matching still requires actual target ledger/documents, amount/date
evidence, duplicate safeguards and the existing approval rules. The package does
not transfer customer-wallet balances, customer links, invoices, bank statements,
FX balances or browser preferences. It does not guarantee every line is matched.

## Validation

`bankMatchingProfile.test.js` covers a fresh database with different IDs,
read-only preflight, idempotent restarts, exact-hint use by the real bank classifier,
conflict rollback, protected merchant ownership, and portable snapshot extraction.
Existing `bankMerchants.test.js` covers supplier detection and refund safeguards.
