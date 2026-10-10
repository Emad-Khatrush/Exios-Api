const ENGINES = ['ledger', 'purchases', 'classification', 'history', 'partners', 'yuan'];
const ErrorHandler = require('../../../utils/errorHandler');
const invalid = () => new ErrorHandler(400, 'إعدادات المطابقة غير صالحة؛ أعد اختيار الطرق وفترة التاريخ.');

// Preferences only narrow proposals. Duplicate and transfer checks are independent.
function preferences(input) {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { throw invalid(); }
  }
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw invalid();
  if (input.engines != null && (!Array.isArray(input.engines) || input.engines.some(e => !ENGINES.includes(e)))) throw invalid();
  const proposalDays = input.proposalDays ?? 7, automaticDays = input.automaticDays ?? 3;
  if (![0, 1, 3, 7].includes(proposalDays) || ![0, 1, 3].includes(automaticDays)) throw invalid();
  return { engines: input.engines ?? ENGINES, proposalDays, automaticDays, requireIdentity: input.requireIdentity === true };
}

function permittedHint(hint, settings) {
  if (!hint || hint.isRefund || hint.source === 'alipay') return hint;
  const engine = hint.source === 'bill' || hint.source === 'order' ? 'purchases'
    : hint.source === 'history' ? 'history' : hint.source === 'yuan' ? 'yuan' : 'classification';
  if (settings.engines.includes(engine)) return hint;
  return { ...hint, account: null, link: null, billId: null, suggestedBillId: null, billCandidates: [],
    source: null, requiresConfirmation: true, reason: null, exactMatch: undefined };
}

module.exports = { preferences, permittedHint };
