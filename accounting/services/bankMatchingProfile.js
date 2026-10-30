// Portable configuration only. Never copies statements, invoices, balances or ledger entries.
const crypto = require('crypto');
const { Account, AccountingOffice } = require('../models');
const { Vendor, BankRule, BankStatementLine } = require('../models/documents');
const { BankMatchingHint: Hint, BankMatchingProfileRun: Run } = require('../models/bankMatchingProfile');
const { normalize } = require('./posting/bank');
const id = v => String(v?._id || v || '');
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const blank = { version: 1, accounts: [], vendors: [], rules: [], history: [] };
async function snapshot() {
  const [accounts, vendors, rules] = await Promise.all([Account.find().lean(), Vendor.find({ isActive: true }).lean(), BankRule.find().lean()]);
  const byId = new Map(accounts.map(a => [id(a), a]));
  const used = new Set(), code = accountId => {
    if (!accountId) return null;
    const a = byId.get(id(accountId));
    if (!a || !a.isActive || a.isGroup) throw Error('A matching reference uses a missing, inactive or group account.');
    used.add(a.code); return a.code;
  };
  const result = { ...blank, vendors: [], rules: [], history: [] };
  for (const r of rules) result.rules.push({ accountCode: code(r.accountId), keyword: r.keyword, direction: r.direction || 'any',
    counterAccountCode: code(r.counterAccountId), office: r.office || '', priority: r.priority || 0, vendorName: r.vendorName || '' });
  for (const v of vendors.filter(v => v.bankNameKey || v.bankPurpose || v.bankAliases?.length || v.bankMappings?.length || rules.some(r => normalize(r.vendorName) === normalize(v.name)))) {
    const mappings = (v.bankMappings || []).map(m => ({ accountCode: code(m.accountId), merchant: m.merchant, counterAccountCode: code(m.counterAccountId) }));
    if (v.bankAccountCode) {
      const target = accounts.find(a => a.code === v.bankAccountCode);
      if (!target) throw Error('A merchant references a missing account code.'); code(target._id);
    }
    result.vendors.push({ name: v.name, seedKey: v.seedKey || '', bankNameKey: v.bankNameKey || '', type: v.type,
      defaultCurrency: v.defaultCurrency, bankPurpose: v.bankPurpose || '', bankAccountCode: v.bankAccountCode || '', bankOffice: v.bankOffice || '',
      bankAliases: v.bankAliases || [], mappings });
  }
  // Same history window and exact normalized descriptions as the live guesser.
  for (const a of accounts.filter(a => a.isCash && a.isActive && !a.isGroup)) {
    const old = await BankStatementLine.find({ accountId: a._id, lineStatus: 'created_entry' }).sort({ updatedAt: -1 }).limit(500)
      .populate('entryId', 'lines').populate('billId', 'lines').lean();
    const seen = new Set();
    for (const line of old) {
      const description = normalize(line.description);
      if (!description || seen.has(description) || !line.entryId) continue;
      let target, office;
      if (line.billId) {
        const costs = line.billId.lines || [];
        if (!costs.length || !costs.every(l => l.target === 'expense' && l.accountId) || new Set(costs.map(l => id(l.accountId))).size !== 1 || new Set(costs.map(l => l.office).filter(Boolean)).size > 1) continue;
        target = costs[0].accountId; office = costs[0].office;
      } else {
        const other = line.entryId.lines.find(l => id(l.accountId) !== id(a));
        if (!other) continue; target = other.accountId; office = other.office;
      }
      const counter = byId.get(id(target));
      if (!counter?.isActive || counter.isGroup) continue;
      seen.add(description);
      result.history.push({ accountCode: code(a._id), description, counterAccountCode: code(target), office: office || '' });
    }
  }
  result.accounts = accounts.filter(a => used.has(a.code)).map(a => ({ code: a.code, type: a.type, currency: a.currency || 'USD', isCash: !!a.isCash, office: a.office || '' })).sort((a,b) => a.code.localeCompare(b.code));
  result.rules.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  result.vendors.sort((a,b) => a.name.localeCompare(b.name));
  result.history.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return result;
}
async function apply(profile, { dryRun = true } = {}) {
  if (profile?.version !== 1 || !['accounts', 'vendors', 'rules', 'history'].every(k => Array.isArray(profile[k]) && profile[k].length <= 10000)) throw Error('Invalid bank matching profile.');
  if (!profile.rules.length && !profile.vendors.length && !profile.history.length) return { empty: true };
  await Promise.all([Hint.init(), Run.init()]);
  if (!dryRun) await Promise.all([Hint.createIndexes(), Run.createIndexes()]);
  const digest = hash(profile);
  if (await Run.exists({ hash: digest })) return { alreadyApplied: true, hash: digest };
  // Serializable import marker; all preflight checks and writes share one transaction.
  return require('./transaction').runInTransaction(async session => {
    if (await Run.exists({ hash: digest }).session(session)) return { alreadyApplied: true, hash: digest };
    const accounts = await Account.find().session(session).lean(), offices = await AccountingOffice.find().session(session).lean();
    const byCode = new Map(accounts.map(a => [a.code, a])), declared = new Set(profile.accounts.map(a => a.code));
    const office = value => { if (value && !offices.some(o => o.code === value)) throw Error(`Missing office ${value}`); return value || undefined; };
    const resolve = value => {
      if (!value) return null;
      const a = byCode.get(value);
      if (!declared.has(value) || !a?.isActive || a.isGroup) throw Error(`Missing/inactive account ${value}`);
      return a._id;
    };
    for (const expected of profile.accounts) {
      const actual = byCode.get(expected.code);
      if (!actual || actual.type !== expected.type || (actual.currency || 'USD') !== expected.currency || !!actual.isCash !== expected.isCash || (actual.office || '') !== expected.office) throw Error(`Account configuration differs: ${expected.code}`);
      resolve(expected.code);
    }
    const changes = { vendors: [], rules: [], hints: [] }, claimed = new Map(), vendorNames = new Map(), vendorKeys = new Set();
    const existingVendors = await Vendor.find().session(session).lean();
    for (const v of profile.vendors) {
      if (!String(v.name || '').trim() || !['carrier','supplier','service','funder','other'].includes(v.type)) throw Error('Invalid merchant definition.');
      const found = existingVendors.filter(e => (v.seedKey && e.seedKey === v.seedKey) || (v.bankNameKey && e.bankNameKey === v.bankNameKey) || normalize(e.name) === normalize(v.name));
      if (found.length > 1) throw Error(`Ambiguous vendor: ${v.name}`);
      const current = found[0];
      const vendorKey = current ? id(current) : normalize(v.name);
      if (vendorKeys.has(vendorKey)) throw Error('Profile contains duplicate vendor definitions.');
      vendorKeys.add(vendorKey); vendorNames.set(v.name, current?.name || v.name);
      if (current && (!current.isActive || current.type !== v.type)) throw Error(`Vendor configuration differs: ${v.name}`);
      const set = {}, aliases = [...new Set([...(current?.bankAliases || []), ...(v.bankAliases || [])])], mappings = [...(current?.bankMappings || [])];
      for (const key of ['bankPurpose','bankAccountCode','bankOffice']) if (v[key]) {
        if (current?.[key] && current[key] !== v[key]) throw Error(`Vendor configuration differs: ${v.name} / ${key}`);
        set[key] = v[key];
      }
      if (v.bankAccountCode) resolve(v.bankAccountCode); office(v.bankOffice);
      for (const m of v.mappings || []) {
        const accountId = resolve(m.accountCode), counterAccountId = resolve(m.counterAccountCode);
        if (!byCode.get(m.accountCode)?.isCash || !m.merchant) throw Error('Invalid merchant mapping.');
        const key = `${m.accountCode}:${m.merchant}`, owner = current ? id(current) : normalize(v.name);
        if (claimed.has(key) && claimed.get(key) !== owner) throw Error('Profile has conflicting merchant mappings.'); claimed.set(key, owner);
        const taken = existingVendors.filter(e => e.bankMappings?.some(x => id(x.accountId) === id(accountId) && x.merchant === m.merchant));
        if (taken.some(e => !current || id(e) !== id(current))) throw Error(`Merchant mapping already belongs to another vendor: ${v.name}`);
        const same = mappings.find(x => id(x.accountId) === id(accountId) && x.merchant === m.merchant);
        if (same && id(same.counterAccountId) !== id(counterAccountId)) throw Error(`Merchant cost account differs: ${v.name}`);
        if (!same) mappings.push({ accountId, merchant: m.merchant, ...(counterAccountId && { counterAccountId }) });
      }
      const definition = { name: v.name, type: v.type, defaultCurrency: v.defaultCurrency || 'USD', ...(v.seedKey && { seedKey: v.seedKey }), ...(v.bankNameKey && { bankNameKey: v.bankNameKey }) };
      changes.vendors.push({ current, set: { ...set, bankAliases: aliases, bankMappings: mappings }, definition });
    }
    const existingRules = await BankRule.find().session(session).lean(), seenRules = new Map();
    for (const r of profile.rules) {
      const accountId = resolve(r.accountCode), counterAccountId = resolve(r.counterAccountCode);
      if (!r.keyword?.trim() || !['in','out','any'].includes(r.direction) || !Number.isFinite(r.priority) || !counterAccountId || (accountId && (!byCode.get(r.accountCode).isCash || id(accountId) === id(counterAccountId)))) throw Error('Invalid bank rule.');
      const fields = { accountId, counterAccountId, keyword: r.keyword, direction: r.direction, priority: r.priority, vendorName: vendorNames.get(r.vendorName) || r.vendorName || '', office: office(r.office) };
      const key = JSON.stringify([r.accountCode, normalize(r.keyword), r.direction]);
      const signature = value => JSON.stringify([id(value.counterAccountId), value.office || '', value.priority || 0, value.vendorName || '']);
      const found = existingRules.filter(e => id(e.accountId) === id(accountId) && normalize(e.keyword) === normalize(r.keyword) && (e.direction || 'any') === r.direction);
      if (found.some(e => signature(e) !== signature(fields)) || (seenRules.has(key) && seenRules.get(key) !== signature(fields))) throw Error(`Bank rule differs: ${r.keyword}`);
      if (!found.length && !seenRules.has(key)) changes.rules.push({ ...fields, seedKey: `matching-profile:${hash(key)}` });
      seenRules.set(key, signature(fields));
    }
    const existingHints = await Hint.find().session(session).lean(), hintKeys = new Map();
    for (const h of profile.history) {
      const accountId = resolve(h.accountCode), counterAccountId = resolve(h.counterAccountCode);
      if (!byCode.get(h.accountCode)?.isCash || !h.description || !counterAccountId || id(accountId) === id(counterAccountId)) throw Error('Invalid history hint.');
      const fields = { accountId, counterAccountId, description: normalize(h.description), office: office(h.office) };
      const key = `${h.accountCode}:${fields.description}`, signature = JSON.stringify([id(counterAccountId), fields.office || '']);
      const found = existingHints.find(e => id(e.accountId) === id(accountId) && e.description === fields.description);
      if ((found && JSON.stringify([id(found.counterAccountId), found.office || '']) !== signature) || (hintKeys.has(key) && hintKeys.get(key) !== signature)) throw Error('History hint conflicts with existing configuration.');
      if (!found && !hintKeys.has(key)) changes.hints.push(fields); hintKeys.set(key, signature);
    }
    const counts = { vendors: changes.vendors.filter(v => !v.current).length, rules: changes.rules.length, history: changes.hints.length };
    if (!dryRun) {
      for (const v of changes.vendors) {
        if (v.current) await Vendor.updateOne({ _id: v.current._id }, { $set: v.set }, { session });
        else await Vendor.create([{ ...v.definition, ...v.set }], { session });
      }
      if (changes.rules.length) await BankRule.create(changes.rules, { session, ordered: true });
      if (changes.hints.length) await Hint.create(changes.hints, { session, ordered: true });
      const [run] = await Run.create([{ hash: digest, appliedAt: new Date(), counts }], { session });
      await require('./audit').logAudit({ action: 'bank.matchingProfile', model: 'AccountingBankMatchingProfileRun', docId: run._id, after: { hash: digest, counts } }, session);
    }
    return { hash: digest, dryRun, ...counts };
  });
}
module.exports = { snapshot, apply, normalize };
