// Receipt and payment vouchers (spec 7): any entry that moved a cash box, bank or e-wallet can be
// printed as a voucher. Money in = receipt (سند قبض), money out = payment (سند صرف). The number is
// taken from its own series the first time the voucher is opened and never changes.
const ErrorHandler = require('../../utils/errorHandler');
const { JournalEntry, Voucher } = require('../models');
const { Vendor } = require('../models/documents');
const User = require('../../models/user');
const { getConfig } = require('./config');
const { nextDocNumber } = require('./posting/common');

const PREFIX = { receipt: 'RV', payment: 'PV' };
const fail = (status, message) => new ErrorHandler(status, message);

async function getVoucher(entryId, { session, user }) {
  const entry = await JournalEntry.findById(entryId).populate('createdBy', 'firstName lastName').session(session).lean();
  if (!entry) throw fail(404, 'القيد غير موجود');
  const { accountsById, currencies, offices } = await getConfig();
  const cashLines = entry.lines.filter((line) => accountsById.get(String(line.accountId))?.isCash);
  if (!cashLines.length) throw fail(400, 'هذا القيد لم يحرّك خزينة أو بنكاً، فلا سند له');
  const net = cashLines.reduce((sum, line) => sum + line.debit - line.credit, 0);
  if (net === 0) throw fail(400, 'القيد تحويل بين الخزائن: لا قبض فيه ولا صرف');
  const kind = net > 0 ? 'receipt' : 'payment';

  let voucher = await Voucher.findOne({ entryId: entry._id }).session(session);
  if (!voucher) {
    const number = await nextDocNumber(PREFIX[kind], entry.day, session);
    [voucher] = await Voucher.create([{ entryId: entry._id, kind, number, createdBy: user?._id }], { session });
  }

  // The boxes that took or gave the money, each in its own currency
  const cash = cashLines.map((line) => {
    const account = accountsById.get(String(line.accountId));
    const currency = account.currency || 'USD';
    return {
      code: account.code, name: account.name, office: offices.get(account.office)?.name || account.office, currency, decimals: currencies.get(currency)?.decimals ?? 2,
      amount: Math.abs(line.amountCurrency ?? (line.debit - line.credit)), usd: Math.abs(line.debit - line.credit), rate: line.rate || null,
    };
  });
  const other = entry.lines.filter((line) => !accountsById.get(String(line.accountId))?.isCash);
  const partnerId = entry.lines.find((line) => line.partnerId)?.partnerId;
  const vendorId = entry.lines.find((line) => line.vendorId)?.vendorId;
  const employeeId = entry.lines.find((line) => line.employeeId)?.employeeId;
  const [partner, vendor, employee] = await Promise.all([
    partnerId && User.findById(partnerId).select('firstName lastName customerId phone').lean(),
    vendorId && Vendor.findById(vendorId).select('name').lean(),
    employeeId && User.findById(employeeId).select('firstName lastName').lean(),
  ]);
  const person = partner ? `${partner.firstName || ''} ${partner.lastName || ''}`.trim() : vendor?.name || (employee ? `${employee.firstName || ''} ${employee.lastName || ''}`.trim() : null);

  return {
    number: voucher.number, kind, day: entry.day, status: entry.status, entryId: entry._id, entryNumber: entry.number, eventType: entry.eventType,
    description: entry.description, cash, totalUsd: Math.abs(net),
    party: person ? { name: person, customerId: partner?.customerId, type: partner ? 'customer' : vendor ? 'vendor' : 'employee' } : null,
    against: other.filter((line) => line.debit || line.credit).map((line) => {
      const account = accountsById.get(String(line.accountId));
      return { code: account?.code, name: account?.name, label: line.label, usd: line.debit || line.credit };
    }),
    createdBy: entry.createdBy ? `${entry.createdBy.firstName || ''} ${entry.createdBy.lastName || ''}`.trim() : null,
    printedAt: new Date(),
  };
}

module.exports = { getVoucher };
