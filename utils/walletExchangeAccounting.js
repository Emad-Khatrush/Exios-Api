// Paired wallet transfer: one journal shared by both statement events and replay.
// Also remains compatible with installations where accounting is not present.
const fs = require('fs');
const path = require('path');
const available = () => fs.existsSync(path.join(__dirname, '../accounting/services/config.js'));

async function assertPeriod(user, day, session) {
  if (available()) await require('../accounting/services/periodGuard').assertOpenPeriod(user, day, { session });
}

async function postExchange(exchangeOrId, options = {}) {
  if (!available()) return { pending: true };
  const Exchange = require('../models/walletExchange');
  const exchange = typeof exchangeOrId === 'object' && exchangeOrId.fromCurrency ? exchangeOrId
    : await Exchange.findById(exchangeOrId).session(options.session);
  if (!exchange) throw new Error('Wallet exchange not found');
  const { settings, offices } = await require('../accounting/services/config').getConfig();
  if (!options.isHistorical && !settings?.liveEnabled) return { pending: true };
  const { JournalEntry } = require('../accounting/models');
  const existing = await JournalEntry.findOne({ eventKey: `WALLET_EXCHANGE:${exchange._id}` }).session(options.session || null).lean();
  if (existing) return { entryId: existing._id };
  const { resolveAccount, RateBook, valueOut, addFxLine, toCurrencyMinor } = require('../accounting/services/posting/common');
  const { postEntry } = require('../accounting/services/ledger');
  const { walletRole } = require('../accounting/services/roles');
  const from = await resolveAccount(walletRole(exchange.fromCurrency));
  const to = await resolveAccount(walletRole(exchange.toCurrency));
  const rates = new RateBook(options.session);
  const creator = await require('../models/user').findById(exchange.createdBy).select('office city').session(options.session || null).lean();
  const office = [exchange.office, creator?.office, creator?.city, settings.defaultOffice].find(value => value && offices.has(value));
  // Wallet documents store hundredths; accounting currency precision is configurable
  // (LYD may have three decimals). Convert units at this boundary only.
  const fromMinor = await toCurrencyMinor(exchange.fromMinor / 100, exchange.fromCurrency);
  const toMinor = await toCurrencyMinor(exchange.toMinor / 100, exchange.toCurrency);
  const fromUsd = await valueOut(from, fromMinor, { day: exchange.day, rates, partnerId: exchange.user });
  const toUsd = await rates.toUsd(toMinor, exchange.toCurrency, exchange.day);
  const line = (account, currency, minor, usd, debit) => ({ accountId: account._id,
    debit: debit ? usd : 0, credit: debit ? 0 : usd, currency,
    amountCurrency: debit ? minor : -minor, partnerId: exchange.user, office,
    label: `صرافة محفظة العميل ${exchange.fromCurrency} → ${exchange.toCurrency}` });
  const lines = [line(from, exchange.fromCurrency, fromMinor, fromUsd, true),
    line(to, exchange.toCurrency, toMinor, toUsd, false)];
  await addFxLine(lines, office, 'فرق تقييم صرافة محفظة العميل');
  const entry = await postEntry({ eventType: 'TRANSFER', eventKey: `WALLET_EXCHANGE:${exchange._id}`,
    date: exchange.day, description: `صرافة داخل محفظة العميل بسعر ${exchange.rate} دينار للدولار`,
    source: { model: 'WalletExchange', id: exchange._id }, lines, fallbacks: rates.fallbacks,
    ...(options.isHistorical && { isHistorical: true, migrationRunId: options.migrationRunId }),
  }, { session: options.session, user: options.user, onLocked: 'reject' });
  await rates.lock();
  // A dry run must not mark the operational record posted; it may be discarded.
  if (!options.isHistorical) await Exchange.updateOne({ _id: exchange._id }, { $set: { 'posting.status': 'posted', 'posting.entryId': entry._id } }, { session: options.session });
  return { entryId: entry._id };
}
module.exports = { available, assertPeriod, postExchange };
