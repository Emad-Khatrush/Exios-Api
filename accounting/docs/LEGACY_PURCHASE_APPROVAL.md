# Adopt legacy order purchase items

The order Costs section now shows an approval action next to each legacy `purchaseItems` row.

The authoritative source amount, currency, description and identity are re-read on the server. A SHA-256 snapshot fingerprint rejects stale approvals. The user chooses the vendor, approval day, optional exchange rate and payment account. Default approval creates an unpaid supplier bill; it does not touch cash or customer wallets. A new payment requires its own explicit confirmation.

An active supplier bill linked by `lines.purchaseItemId` or the historical `MIG:PURCH:<itemId>` key replaces the approval action with a link to that original bill. Draft links are labeled as drafts, rather than claiming their cost was posted. Canceled bills do not permanently block a fresh approval attempt.

Existing bill lines on the same order with the same amount and currency are offered as linking candidates. Linking attaches `purchaseItemId` only; it creates no financial posting or payment. A line already attached to another item cannot be reused. Existing bill edits retain the source link through the existing financial-edit workflow.

GET `orders/:id/legacy-purchases` requires reports or purchases permission. POST `orders/:id/legacy-purchases/:itemId/approve` requires purchases permission. Both new-bill and existing-bill paths use the existing period guard, including its owner exception. The new-bill path preserves existing duplicate-cost review rules and records the original item date in its note. The legacy item itself is not rewritten during approval.

The order mutation version serializes competing approvals, including the generic supplier-bill validation path. Per-attempt request keys make retries safe; the active source-item lookup also prevents different request keys from producing duplicate bills. New invoices and metadata links are audited through the existing accounting audit system.

Tests: `accounting/tests/legacyPurchaseApproval.test.js` (source integrity, retries, concurrency, migrated links, existing-line attachment, period lock, CNY valuation, explicit new payment, and HTTP permissions). Frontend: `LegacyPurchaseCosts.test.tsx` verifies creation, existing-link mode, and already-adopted rows. Browser fixtures use isolated synthetic responses, not company balances.
