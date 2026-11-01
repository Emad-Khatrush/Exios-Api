# Same-currency supplier settlement

An LYD 16,500 bill paid with LYD 16,500 closes at its booked USD payable value. The payment-day USD rate and treasury carrying rate do not leave a supplier advance or change the bill's cost. Any balancing USD difference is posted to realized FX. Only an actual excess of native currency becomes an advance.

For an already posted, unallocated payment, use Payments > supplier advance and select the original payment. Choose bills in the payment's currency and allocate their remaining amounts. The new document debits the bills' payable keys and credits the existing advance key at the original advance's carrying value. It never credits cash again.

Traceable source eligibility is conservative: a posted cash payment, positive advance, no original bill allocations, and an advance pool fully reconciled to known payments and linked uses. Legacy pooled uses or refunds with no source attribution disable source selection rather than guessing which payment remains. The existing USD pooled-allocation path remains available.

The source and vendor are transactionally locked; allocations still lock and recheck each bill. Linked uses carry `advancePaymentId`, `advanceConsumedUsd`, `advanceAmount`, and original currency. Source cancellation is refused until linked settlements are canceled. Canceling a settlement restores both the payable and the advance, including its FX reversal, without moving cash.

No existing production document is modified by this code change. Actual settlement requires a user to select and post it. Existing payments must not be re-entered as cash payments.

Validation: isolated API tests cover both FX directions beyond the former 10% limit, real native overpayment, underpayment rejection, source reuse, idempotency, currency/vendor checks, partial consumption, competing confirmations, cancellation and native report totals. UI tests cover native entry and linking a prior payment without cash fields.

Regression note: the pre-existing phase2 Alipay top-up test expects generic FX account 710100; current setup posts to realized FX loss 710300. The same failure was reproduced using the HEAD version of payables.js before this change. The other four selected payment/cost/cancellation regression cases passed.
