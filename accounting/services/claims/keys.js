// Keys of what a customer owes (spec 5.1). Every line on the receivable, deferred revenue and
// revenue accounts for one claim carries the same key, so the ledger can answer "how much is
// billed / still owed / recognised" for each purchase invoice, package and general debt.
const purchaseKey = (orderId) => `PUR:${orderId}`;
const shipmentKey = (orderId, packageId) => `SHP:${orderId}:${packageId}`;
const generalDebtKey = (balanceId) => `GEN:${balanceId}`;
// The transport fee to another office charged on a package, beside its shipping (spec v8)
const domesticFeeKey = (orderId, packageId) => `SHP:${orderId}:${packageId}:DOM`;
const isDomesticFeeKey = (arKey) => String(arKey || '').endsWith(':DOM');

// A package's charge in cents: weight x unit price, rounded the way the system bills it at
// delivery (toFixed(2)), so the claim is exactly what the customer is asked to pay
const packageChargeCents = (pkg) => {
  const charge = Number(pkg?.deliveredPackages?.weight?.total || 0) * Number(pkg?.deliveredPackages?.exiosPrice || 0);
  return Math.round(Number(charge.toFixed(2)) * 100);
};

function parseKey(arKey) {
  const [kind, first, second] = String(arKey || '').split(':');
  if (kind === 'PUR') return { kind: 'purchase', orderId: first };
  if (kind === 'SHP') return { kind: 'shipment', orderId: first, packageId: second, ...(isDomesticFeeKey(arKey) && { domesticFee: true }) };
  if (kind === 'GEN') return { kind: 'general', balanceId: first };
  return { kind: 'unknown' };
}

// Entries that change how much a claim is (billing, re-pricing, edits, cancellation)
const CLAIM_EVENTS = ['CLAIM', 'PURCHASE_BILLED', 'SHIPMENT_BILLED', 'SHIPMENT_REPRICE', 'AMOUNT_EDIT', 'ORDER_CANCEL', 'PACKAGE_REMOVE', 'GENERAL_DEBT'];

module.exports = { packageChargeCents, purchaseKey, shipmentKey, generalDebtKey, domesticFeeKey, isDomesticFeeKey, parseKey, CLAIM_EVENTS };
