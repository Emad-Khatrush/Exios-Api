// Statement lines the import must never post as a new cost: they stay unmatched for the matching
// page, where the person links them to what the books already hold.
//  - money leaving a partner's current account (Wasl...) for Alipay transfers: it pays supplier
//    bills, buys yuan or pays a salary, each recorded on its own screen; the grouped line is taken
//    apart there («تفكيك السطر»), never booked as one expense of the whole total
//  - a line that is exactly the total of two or three operations already in the books
const { partsOf } = require('./partnerTransfers');
const { combinations } = require('./bankCombos');

function holdReason(account, line, movements = []) {
  if (account?.cashKind === 'current' && line.amount < 0 && partsOf(line.description)) {
    return { reason: 'حوالات Alipay من الحساب الجاري: تُطابق بعد الرفع مع فواتير الموردين أو شراء اليوان أو المرتب، ولا تُسجل مصروفًا جديدًا', combinations: combinations(line, movements).options };
  }
  const found = combinations(line, movements).options;
  if (found.length) {
    const first = found[0].entries.map((e) => e.number).join(' + ');
    return { reason: `مجموع عمليات مسجلة يساوي هذا السطر (${first}${found.length > 1 ? ` و${found.length - 1} احتمالات أخرى` : ''})؛ يُحفظ للمطابقة ولا يُرحّل`, combinations: found };
  }
  return null;
}

module.exports = { holdReason };
