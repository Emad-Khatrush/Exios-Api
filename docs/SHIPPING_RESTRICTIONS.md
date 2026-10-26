# Order shipping restrictions

Implemented locally on 24 October 2026. This is not confirmation of deployment to QA or production.

## Use

Open an existing order → Details → Order → beneath **Order has a problem**. Check **ممنوعة من الشحن**, enter the required reason, and select **Save**. The control uses the form's shared toggle chip, text field and button styles. Uncheck and save to release the restriction. Save or discard other unsaved invoice edits first so that reloading the order cannot lose them.

Staff who can edit orders can set or release the flag; the dedicated endpoint also accepts accountants. Canceled/deleted orders cannot be changed through this action. It is an operational update, so it does not require reopening an accounting period or post a journal entry. The order itself, its money and existing trip membership are not canceled or removed by the flag.

## Model and API

- `shippingBlocked`: boolean; missing old values mean false.
- `shippingBlockReason`: required when blocking, up to 500 characters, cleared on release.
- `shippingBlockedAt`, `shippingBlockedBy`: current block metadata.
- `PUT /api/order/:id/shipping-block`, body `{ "blocked": true, "reason": "..." }`.

The update and its before/after audit values are saved in one transaction. All changes use the same order document that is written when adding packages to a trip, so concurrent additions and restrictions cause transaction retries rather than silently using stale order data.

The general order/package editor cannot change these fields directly. Shipping stage advancement from before dispatch to shipped or later is rejected while the order is blocked. Actual arrivals of already shipped goods can still be recorded; this flag does not rewrite physical history.

## Shipment and warehouse behavior

Adding a blocked order's packages to an international or domestic trip fails with the order numbers in the error. Mixed batches are rejected atomically, so users can deselect the blocked orders and retry. Internal shipping from a warehouse checks live order data and rejects blocked orders as well.

Goods can still be placed in an office warehouse to record their actual location. A red restriction badge appears on the package rows. Existing trip membership is retained when an order is later blocked; releasing, removing or relocating those packages remains an explicit operational decision.

## X-Tracking

The card displays a red **ممنوعة من الشحن** badge and the saved reason. The **ممنوعة من الشحن** filter includes its own counter and works with all payment filters and both existing search modes. Category counters, payment/category matrices and direct count queries all include the flag. Normal browsing follows the existing active-order rule; searches can include completed orders, as before.

This is independent of the general **Has a problem** flag. Marking an order blocked does not automatically mark it finished, canceled, unpaid or problematic.
