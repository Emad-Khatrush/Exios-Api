const ErrorHandler = require('./errorHandler');
// Shared boundary for master sales goals (lowercase) and accounting numbering (uppercase).
function seaFields(input, previous = {}) {
  if ((input.shippingType || previous.shippingType) !== 'sea') return { seaLoadType:null, seaType:null };
  const normalize = value => {
    if (value == null || value === '') return null;
    const key = String(value).toUpperCase();
    if (!['FCL','LCL'].includes(key)) throw new ErrorHandler(400, 'Invalid sea load type');
    return key;
  };
  const load = input.seaLoadType === undefined ? undefined : normalize(input.seaLoadType);
  const legacy = input.seaType === undefined ? undefined : normalize(input.seaType);
  if (load !== undefined && legacy !== undefined && load !== legacy) throw new ErrorHandler(400, 'Sea freight classifications disagree');
  const chosen = load !== undefined ? load : legacy !== undefined ? legacy : normalize(previous.seaLoadType || previous.seaType);
  return { seaLoadType:chosen, seaType:chosen?.toLowerCase() || null };
}
module.exports = { seaFields };
