// Export of journal entries to Odoo (spec 13), as rows of Odoo's journal-entry import
// (account.move with its line_ids). Each export is a numbered batch: its entries are marked so
// the next export only takes what is new, and a batch can be undone if Odoo refused the file.
//
// External ID = the entry number, so importing the same entry twice updates it instead of
// duplicating it. A trip on a line becomes the trip's Odoo analytic account (odoReferenceCode).
const { JournalEntry, Journal, Account, MigrationRun, AccountingSettings, OdooExport } = require('../models');
const Inventory = require('../../models/inventory');
const User = require('../../models/user');
const ErrorHandler = require('../../utils/errorHandler');
const { getRate } = require('./rates');
const { nextSeq } = require('./counter');

const refuse = (message) => new ErrorHandler(400, message);
const COMPANY_CURRENCIES = ['USD', 'LYD'];
const DEFAULT_SETTINGS = { companyCurrency: 'USD', defaultJournal: 'Miscellaneous Operations' };
const DECIMALS = { USD: 2, LYD: 3 };

async function odooSettings() {
  const settings = await AccountingSettings.findOne({ key: 'main' }).select('odoo').lean();
  return { ...DEFAULT_SETTINGS, ...(settings?.odoo || {}) };
}

async function saveSettings({ companyCurrency, defaultJournal }) {
  const current = await odooSettings();
  const next = { ...current };
  if (companyCurrency !== undefined) {
    if (!COMPANY_CURRENCIES.includes(companyCurrency)) throw refuse('عملة الشركة في أودو يجب أن تكون USD أو LYD');
    next.companyCurrency = companyCurrency;
  }
  if (defaultJournal !== undefined) {
    if (!String(defaultJournal).trim()) throw refuse('اكتب اسم اليومية الافتراضية في أودو');
    next.defaultJournal = String(defaultJournal).trim();
  }
  await AccountingSettings.updateOne({ key: 'main' }, { $set: { odoo: next } });
  return next;
}

// Entries of a dry run waiting for review (or discarded) are not real yet and never go out
async function unfinishedRunIds() {
  const runs = await MigrationRun.find({ status: { $ne: 'committed' } }).select('runId').lean();
  return runs.map((run) => run.runId);
}

async function pendingMatch(upTo) {
  const match = { exportedToOdooAt: null };
  if (upTo) match.day = { $lte: upTo };
  const unfinished = await unfinishedRunIds();
  if (unfinished.length) match.migrationRunId = { $nin: unfinished };
  return match;
}

// What the next export would take, and what stops it (accounts with no Odoo code)
async function pendingSummary(upTo) {
  const match = await pendingMatch(upTo);
  const [totals] = await JournalEntry.aggregate([
    { $match: match },
    { $group: { _id: null, count: { $sum: 1 }, firstDay: { $min: '$day' }, lastDay: { $max: '$day' }, totalDebit: { $sum: '$totalDebit' } } },
  ]);
  const used = await JournalEntry.aggregate([
    { $match: match }, { $unwind: '$lines' },
    { $group: { _id: '$lines.accountId', lines: { $sum: 1 } } },
  ]);
  const accounts = await Account.find({ _id: { $in: used.map((row) => row._id) } }).select('code name odooCode').lean();
  const lines = new Map(used.map((row) => [String(row._id), row.lines]));
  const unmapped = accounts.filter((account) => !String(account.odooCode || '').trim())
    .map((account) => ({ _id: account._id, code: account.code, name: account.name, lines: lines.get(String(account._id)) || 0 }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return {
    count: totals?.count || 0, firstDay: totals?.firstDay || null, lastDay: totals?.lastDay || null, totalDebit: totals?.totalDebit || 0,
    unmapped,
  };
}

// Company-currency amounts of an entry's lines, in minor units. In USD they are the ledger's
// cents. In LYD a dinar line keeps its dinars and every other line is converted at the day's
// rate; the rounding difference goes on the biggest line so the entry still balances.
async function companyAmounts(entry, companyCurrency, rateCache) {
  if (companyCurrency === 'USD') return entry.lines.map((line) => ({ debit: line.debit || 0, credit: line.credit || 0 }));
  if (!rateCache.has(entry.day)) rateCache.set(entry.day, (await getRate('LYD', entry.day)).rate);
  const rate = rateCache.get(entry.day);
  // cents x rate -> dirhams (1/1000 LYD)
  const convert = (cents) => Math.round(cents * rate * 10);
  const amounts = entry.lines.map((line) => {
    if (line.currency === 'LYD' && Number.isFinite(line.amountCurrency)) {
      return line.amountCurrency >= 0 ? { debit: line.amountCurrency, credit: 0 } : { debit: 0, credit: -line.amountCurrency };
    }
    return { debit: convert(line.debit || 0), credit: convert(line.credit || 0) };
  });
  const gap = amounts.reduce((sum, a) => sum + a.debit - a.credit, 0);
  if (gap !== 0) {
    const index = amounts.reduce((best, a, i) => (Math.max(a.debit, a.credit) > Math.max(amounts[best].debit, amounts[best].credit) ? i : best), 0);
    if (amounts[index].debit > 0) amounts[index].debit -= gap;
    else amounts[index].credit += gap;
  }
  return amounts;
}

const major = (minor, currency) => Number((minor / 10 ** (DECIMALS[currency] ?? 2)).toFixed(DECIMALS[currency] ?? 2));
const externalId = (number) => `exios_${String(number).replace(/[^A-Za-z0-9]+/g, '_')}`;

// The import rows of these entries: the first row of an entry carries its header, the rest only
// their line. Columns follow Odoo's journal-entry import.
async function buildRows(entries, settings) {
  const accountIds = new Set();
  const journalIds = new Set();
  const partnerIds = new Set();
  const tripIds = new Set();
  entries.forEach((entry) => {
    journalIds.add(String(entry.journalId));
    entry.lines.forEach((line) => {
      accountIds.add(String(line.accountId));
      if (line.partnerId) partnerIds.add(String(line.partnerId));
      if (line.tripId) tripIds.add(String(line.tripId));
    });
  });
  const [accounts, journals, partners, trips] = await Promise.all([
    Account.find({ _id: { $in: [...accountIds] } }).select('code name odooCode').lean(),
    Journal.find({ _id: { $in: [...journalIds] } }).select('code name odooJournal').lean(),
    User.find({ _id: { $in: [...partnerIds] } }).select('customerId').lean(),
    Inventory.find({ _id: { $in: [...tripIds] } }).select('odoReferenceCode voyage').lean(),
  ]);
  const accountById = new Map(accounts.map((a) => [String(a._id), a]));
  const journalById = new Map(journals.map((j) => [String(j._id), j]));
  const partnerById = new Map(partners.map((p) => [String(p._id), p.customerId]));
  const tripById = new Map(trips.map((t) => [String(t._id), t]));

  const missing = accounts.filter((a) => !String(a.odooCode || '').trim());
  if (missing.length) throw refuse(`حسابات بلا رمز أودو: ${missing.map((a) => a.code).join('، ')}. اربطها أولاً.`);

  const company = settings.companyCurrency;
  const rateCache = new Map();
  const rows = [];
  for (const entry of entries) {
    const amounts = await companyAmounts(entry, company, rateCache);
    entry.lines.forEach((line, index) => {
      const trip = line.tripId && tripById.get(String(line.tripId));
      // A line in another currency than the company's keeps its amount in that currency
      const lineCurrency = line.currency || 'USD';
      let currency = '';
      let amountCurrency = '';
      if (lineCurrency !== company) {
        currency = lineCurrency;
        amountCurrency = lineCurrency === 'USD'
          ? major((line.debit || 0) - (line.credit || 0), 'USD')
          : Number.isFinite(line.amountCurrency) ? major(line.amountCurrency, lineCurrency) : '';
        if (amountCurrency === '') currency = '';
      }
      rows.push({
        id: index === 0 ? externalId(entry.number) : '',
        journal_id: index === 0 ? (journalById.get(String(entry.journalId))?.odooJournal || settings.defaultJournal) : '',
        date: index === 0 ? entry.day : '',
        ref: index === 0 ? `${entry.number}${entry.description ? ` - ${entry.description}` : ''}` : '',
        'line_ids/account_id': accountById.get(String(line.accountId))?.odooCode || '',
        'line_ids/partner_id/id': line.partnerId ? (partnerById.get(String(line.partnerId)) || '') : '',
        'line_ids/name': line.label || entry.description || entry.number,
        'line_ids/debit': major(amounts[index].debit, company),
        'line_ids/credit': major(amounts[index].credit, company),
        'line_ids/currency_id': currency,
        'line_ids/amount_currency': amountCurrency,
        'line_ids/analytic_distribution': trip?.odoReferenceCode ? `{ "${trip.odoReferenceCode}": 100 }` : '',
      });
    });
  }
  return rows;
}

const loadEntries = (ids) => JournalEntry.find({ _id: { $in: ids } }).sort({ day: 1, number: 1 }).lean();

// A new batch with every entry not exported yet, up to `upTo`
async function createExport({ upTo, user }) {
  const summary = await pendingSummary(upTo);
  if (!summary.count) throw refuse('لا توجد قيود جديدة للتصدير حتى هذا التاريخ');
  if (summary.unmapped.length) throw refuse(`حسابات بلا رمز أودو: ${summary.unmapped.map((a) => a.code).join('، ')}. اربطها أولاً.`);

  const settings = await odooSettings();
  const entries = await JournalEntry.find(await pendingMatch(upTo)).sort({ day: 1, number: 1 }).lean();
  // Built before anything is marked: a missing rate or mapping leaves nothing half-exported
  const rows = await buildRows(entries, settings);

  const seq = await nextSeq('ODOO_EXPORT');
  const batch = await OdooExport.create({
    number: `ODOO/${String(seq).padStart(5, '0')}`, upTo, firstDay: summary.firstDay, lastDay: summary.lastDay,
    entryIds: entries.map((entry) => entry._id), count: entries.length, totalDebit: summary.totalDebit,
    companyCurrency: settings.companyCurrency, createdBy: user?._id,
  });
  await JournalEntry.updateMany({ _id: { $in: batch.entryIds }, exportedToOdooAt: null }, { $set: { exportedToOdooAt: batch.createdAt, odooExportId: batch._id } });
  return { export: batch.toObject(), rows };
}

// The rows of an earlier batch again (same entries, same external IDs)
async function exportRows(id) {
  const batch = await OdooExport.findById(id).lean();
  if (!batch) throw new ErrorHandler(404, 'دفعة التصدير غير موجودة');
  const settings = { ...(await odooSettings()), companyCurrency: batch.companyCurrency || (await odooSettings()).companyCurrency };
  return { export: batch, rows: await buildRows(await loadEntries(batch.entryIds), settings) };
}

// Odoo refused the file: its entries go back to "not exported"
async function undoExport(id, user) {
  const batch = await OdooExport.findById(id);
  if (!batch) throw new ErrorHandler(404, 'دفعة التصدير غير موجودة');
  if (batch.undoneAt) throw refuse('هذه الدفعة أُلغيت من قبل');
  await JournalEntry.updateMany({ odooExportId: batch._id }, { $set: { exportedToOdooAt: null }, $unset: { odooExportId: '' } });
  batch.undoneAt = new Date();
  batch.undoneBy = user?._id;
  await batch.save();
  return batch.toObject();
}

const listExports = () => OdooExport.find({}).select('-entryIds').sort({ createdAt: -1 }).limit(100).populate('createdBy', 'firstName lastName').lean();

// Exios's side of the weekly comparison: cash boxes and banks, customer wallets, customer claims
async function ourFigures(day) {
  const { getBalance } = require('./carrying');
  const { resolveAccount } = require('./roles');
  const { accountsById } = await require('./config').getConfig();
  const sum = async (accounts) => {
    let total = 0;
    for (const account of accounts) total += (await getBalance(account._id, { upToDay: day })).usd;
    return total;
  };
  const cash = await sum([...accountsById.values()].filter((a) => a.isCash && !a.isGroup));
  const wallets = [];
  for (const role of ['wallet_usd', 'wallet_lyd']) wallets.push(await resolveAccount(role).catch(() => null));
  return {
    cash,
    // Wallets are what we owe customers: shown as a positive amount
    wallets: -(await sum(wallets.filter(Boolean))),
    receivables: await sum([await resolveAccount('customer_receivable')]),
  };
}

async function saveComparison({ day, odoo, note }, user) {
  const { OdooComparison } = require('../models');
  const toCents = (value) => Math.round(Number(value || 0) * 100);
  const ours = await ourFigures(day);
  const [doc] = await OdooComparison.create([{
    day, ours, odoo: { cash: toCents(odoo?.cash), wallets: toCents(odoo?.wallets), receivables: toCents(odoo?.receivables) }, note, createdBy: user?._id,
  }]);
  return doc;
}

const listComparisons = () => require('../models').OdooComparison.find({}).sort({ day: -1, createdAt: -1 }).limit(30).lean();

module.exports = { ourFigures, saveComparison, listComparisons, OdooExport, odooSettings, saveSettings, pendingSummary, buildRows, createExport, exportRows, undoExport, listExports, COMPANY_CURRENCIES };
