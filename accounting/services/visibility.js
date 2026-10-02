// Cancelled documents are hidden by default (owner's decision, spec 19.9): a cancelled entry, its
// reversal, and the claim entries of a cancelled or deleted order (which net to zero) disappear
// together from lists, ledgers and statements, so "50 debit / 50 credit / 0" lines do not clutter
// them. A "show cancelled" switch brings them back. Hiding a pair never changes a balance.
const HIDDEN = { status: { $ne: 'reversed' }, reversalOf: null, hiddenWithCancel: { $ne: true } };

const visibleMatch = (showCanceled) => (String(showCanceled) === 'true' ? {} : HIDDEN);

module.exports = { visibleMatch };
