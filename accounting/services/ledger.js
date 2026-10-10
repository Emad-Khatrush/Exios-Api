const ErrorHandler = require('../../utils/errorHandler');
const { Account, JournalEntry, Journal } = require('../models');
const { lockPeriod } = require('./periodLock');
const { getConfig } = require('./config');
const { resolveAccount } = require('./roles');
const { assertInTransaction } = require('./transaction');
const { nextSeq } = require('./counter');
const { isDay, toDay, dayStart, addDays, yearOf } = require('./dates');
const { USD } = require('./money');

// Up to 5 cents of imbalance (from converting currencies) goes to the rounding account;
// anything bigger is a bug in the caller and the entry is refused.
const MAX_ROUNDING_CENTS = 5;

const DIMENSION_FIELDS = {
  partner: 'partnerId',
  vendor: 'vendorId',
  employee: 'employeeId',
  trip: 'tripId',
  order: 'orderId',
  package: 'packageId',
  office: 'office',
};

const LINE_FIELDS = ['partnerId', 'vendorId', 'orderId', 'packageId', 'tripId', 'employeeId', 'assetId', 'prepaidId', 'office', 'tags', 'arKey', 'apKey', 'label'];

const isCents = (value) => Number.isInteger(value) && value >= 0;

async function resolveLineAccount(line, accountsById, accountsByCode) {
  let account;
  if (line.accountId) account = accountsById.get(String(line.accountId));
  else if (line.role) account = await resolveAccount(line.role);
  else if (line.accountCode) account = accountsByCode.get(line.accountCode);
  if (!account) {
    throw new ErrorHandler(400, `حساب غير موجود في سطر القيد (${line.accountId || line.role || line.accountCode})`);
  }
  return account;
}

async function buildLine(line, index, config) {
  const { accountsById, accountsByCode, offices } = config;
  const account = await resolveLineAccount(line, accountsById, accountsByCode);
  const where = `السطر ${index + 1} (${account.code} ${account.name})`;

  if (account.isGroup) throw new ErrorHandler(400, `${where}: لا يمكن الترحيل على حساب مجموعة`);
  if (!account.isActive) throw new ErrorHandler(400, `${where}: الحساب مؤرشف`);

  const debit = line.debit || 0;
  const credit = line.credit || 0;
  if (!isCents(debit) || !isCents(credit)) throw new ErrorHandler(400, `${where}: المبلغ يجب أن يكون عدداً صحيحاً موجباً بالسنت`);
  if (debit > 0 && credit > 0) throw new ErrorHandler(400, `${where}: السطر لا يكون مديناً ودائناً معاً`);

  const built = { accountId: account._id, accountCode: account.code, debit, credit };
  LINE_FIELDS.forEach((field) => {
    if (line[field] !== undefined && line[field] !== null && line[field] !== '') built[field] = line[field];
  });

  if (account.currency && account.currency !== USD) {
    if (line.currency !== account.currency) {
      throw new ErrorHandler(400, `${where}: عملة السطر يجب أن تكون ${account.currency}`);
    }
    const amount = line.amountCurrency;
    if (!Number.isInteger(amount)) throw new ErrorHandler(400, `${where}: المبلغ بالعملة مطلوب`);
    if ((debit > 0 && amount < 0) || (credit > 0 && amount > 0)) {
      throw new ErrorHandler(400, `${where}: إشارة المبلغ بالعملة لا توافق جهة السطر`);
    }
    built.currency = account.currency;
    built.amountCurrency = amount;
    if (line.rate) built.rate = line.rate;
  } else {
    built.currency = USD;
    built.amountCurrency = debit - credit;
  }

  if (debit === 0 && credit === 0 && !built.amountCurrency) {
    throw new ErrorHandler(400, `${where}: سطر بدون مبلغ`);
  }

  (account.requires || []).forEach((dimension) => {
    const field = DIMENSION_FIELDS[dimension];
    if (field && !built[field]) throw new ErrorHandler(400, `${where}: البُعد "${dimension}" إلزامي على هذا الحساب`);
  });
  if (built.office && !offices.has(built.office)) {
    throw new ErrorHandler(400, `${where}: المكتب "${built.office}" غير معرّف`);
  }

  return built;
}

async function resolveJournal({ journalId, journalCode, eventType }, lines, config, session) {
  if (journalId) return Journal.findById(journalId).session(session);

  let code = journalCode || config.settings?.eventJournals?.[eventType] || 'GEN';
  if (code === '@cash') {
    const cashLine = lines.find((line) => config.accountsById.get(String(line.accountId))?.isCash);
    const journal = cashLine && await Journal.findOne({ defaultAccountId: cashLine.accountId, isActive: true }).session(session);
    if (journal) return journal;
    code = 'GEN';
  }
  return Journal.findOne({ code }).session(session);
}

// Money dated before the opening count (owner's decision 2026-10-03): whatever moved through the
// counted boxes by then is already in the counted amount. An operation entered later with such a
// date (an expense or a deposit forgotten until after go-live) must not move a counted box a
// second time: its box line goes to the opening balance account instead, with a note on the
// entry. The profit of its month is still right, since the expense or revenue line keeps its date.
// What is done on the count day after the count (a withdrawal that afternoon) moves the box as
// usual (config.count.at). The migration's own entries, cash counts and manual entries are left
// alone; a reversal follows the rule only when it undoes a historical entry (otherwise it mirrors
// its original exactly, which was already moved if it had to be).
async function beforeCountLines(input, lines, config, notes) {
  const { count } = config;
  if (!count || input.isHistorical || input.migrationRunId || input.countRule === 'skip') return lines;
  // A count, and a manual entry (suspense settlements among them): the accountant names the box on purpose
  if (['CASHCOUNT', 'OPENING_CASH', 'MANUAL', 'YEAR_CLOSE'].includes(input.eventType)) return lines;
  // In the count: a day before it, the count day itself when the count is its end, or (for an
  // operation with its time) any moment up to the count
  const inputDate = input.date || new Date();
  const day = toDay(inputDate);
  const inCount = isDay(inputDate) ? day < count.day || (day === count.day && count.endOfDay) : new Date(inputDate) <= count.at;
  if (!inCount) return lines;
  const counted = lines.filter((line) => count.accountIds.has(String(line.accountId)));
  if (!counted.length) return lines;
  const opening = await resolveAccount('opening_balance');
  const nameOf = (line) => config.accountsById.get(String(line.accountId))?.name;
  notes.push(`تاريخ العملية ${day} قبل الجرد (${count.day})، والجرد احتسب هذا المال: سُجّل على الأرصدة الافتتاحية بدل ${[...new Set(counted.map(nameOf))].join('، ')}`);
  return lines.flatMap((line) => {
    if (!count.accountIds.has(String(line.accountId))) return [line];
    // A foreign-currency line worth no cents moves nothing once it is in dollars
    if (!line.debit && !line.credit) return [];
    return [{
      accountId: opening._id, accountCode: opening.code, debit: line.debit, credit: line.credit, currency: USD, amountCurrency: line.debit - line.credit,
      label: `قبل يوم الجرد - ${nameOf(line)}${line.label ? `: ${line.label}` : ''}`, ...(line.office && { office: line.office }),
    }];
  });
}

// Validates and saves one journal entry inside the caller's transaction.
// Posting the same eventKey twice returns the first entry instead of creating a second one.
async function postEntry(input, { session, user, onLocked = 'shift' } = {}) {
  assertInTransaction(session);
  if (!input.eventType) throw new Error('eventType is required');
  if (!input.eventKey) throw new Error('eventKey is required');

  const existing = await JournalEntry.findOne({ eventKey: input.eventKey }).session(session);
  if (existing) return existing;

  const settings = await lockPeriod(session);
  const cached = await getConfig();
  const config = { ...cached, settings };
  if (!config.settings) throw new ErrorHandler(400, 'النظام المحاسبي غير مُعدّ بعد. شغّل الإعداد أولاً.');

  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new ErrorHandler(400, 'القيد يحتاج سطرين على الأقل');
  }
  let lines = [];
  for (let i = 0; i < input.lines.length; i++) {
    lines.push(await buildLine(input.lines[i], i, config));
  }
  const notes = [...(input.notes || [])];
  lines = await beforeCountLines(input, lines, config, notes);

  // Every journal movement on a cash account contends on the same transactional mutex. This
  // serializes cash inflows and outflows across screens, including those with no balance check.
  const cashAccountIds = [...new Set(lines
    .filter((line) => config.accountsById.get(String(line.accountId))?.isCash)
    .map((line) => String(line.accountId)))].sort();
  for (const accountId of cashAccountIds) {
    const locked = await Account.updateOne(
      { _id: accountId, isActive: true }, { $inc: { postingVersion: 1 } }, { session },
    );
    if (locked.modifiedCount !== 1) throw new ErrorHandler(400, 'Cash account is no longer available');
  }

  const totalDebit = lines.reduce((sum, line) => sum + line.debit, 0);
  const totalCredit = lines.reduce((sum, line) => sum + line.credit, 0);
  const difference = totalDebit - totalCredit;
  if (difference !== 0) {
    if (Math.abs(difference) > MAX_ROUNDING_CENTS) {
      throw new ErrorHandler(400, `القيد غير متوازن: المدين ${totalDebit / 100} والدائن ${totalCredit / 100}`);
    }
    const rounding = await resolveAccount('rounding');
    const office = lines.find((line) => line.office)?.office;
    lines.push({
      accountId: rounding._id,
      accountCode: rounding.code,
      debit: difference < 0 ? -difference : 0,
      credit: difference > 0 ? difference : 0,
      currency: USD,
      amountCurrency: -difference,
      label: 'فرق تقريب',
      ...(office && { office }),
    });
  }

  const inputDate = input.date || new Date();
  let day = toDay(inputDate);
  // A plain day is stored as the start of that day in Libya; an instant keeps its time
  let date = isDay(inputDate) ? dayStart(day) : new Date(inputDate);
  const { lockDate, migrationGuardDay } = config.settings;
  // A migration dry run is waiting for review: the historical period belongs to it
  const trial = require('./migration/bankTrial').context();
  const bankTrial = process.env.EXIOS_QA === '1' && trial?.session === session && trial?.runId;
  if (migrationGuardDay && !input.migrationRunId && !bankTrial && day <= migrationGuardDay) {
    throw new ErrorHandler(400, `الفترة حتى ${migrationGuardDay} محجوزة للترحيل التاريخي قيد المراجعة. اعتمده أو ألغِه أولاً.`);
  }
  // 'allow' is for the year-closing entry only, which belongs on the last day of a locked year
  if (lockDate && day <= lockDate && onLocked !== 'allow') {
    if (onLocked === 'reject') throw new ErrorHandler(400, `الفترة مقفلة حتى ${lockDate}`);
    notes.push(`تاريخ العملية ${day} في فترة مقفلة، رُحِّل بأول يوم مفتوح`);
    day = addDays(lockDate, 1);
    date = dayStart(day);
  }

  const journal = await resolveJournal(input, lines, config, session);
  if (!journal) throw new ErrorHandler(400, 'الدفتر غير موجود');
  if (!journal.isActive) throw new ErrorHandler(400, `الدفتر ${journal.code} مؤرشف`);

  const year = yearOf(day);
  const counterKey = journal.sequenceResetYearly ? `JE:${journal.code}:${year}` : `JE:${journal.code}`;
  const seq = await nextSeq(counterKey, session);
  const padded = String(seq).padStart(6, '0');
  const number = journal.sequenceResetYearly ? `${journal.sequencePrefix}/${year}/${padded}` : `${journal.sequencePrefix}/${padded}`;

  const [entry] = await JournalEntry.create([{
    number,
    journalId: journal._id,
    date,
    day,
    originalDay: toDay(inputDate),
    description: input.description,
    eventType: input.eventType,
    eventKey: input.eventKey,
    source: input.source,
    reversalOf: input.reversalOf,
    lines,
    totalDebit: Math.max(totalDebit, totalCredit),
    attachments: input.attachments,
    notes,
    createdBy: user?._id,
    isHistorical: !!input.isHistorical,
    migrationRunId: input.migrationRunId,
    bankTrialRunId: bankTrial || undefined,
    fallbacks: input.fallbacks,
  }], { session });

  if (!input.migrationRunId && input.eventType !== 'ALIPAY_REVALUATION') {
    const valuation = require('./posting/alipayValuation');
    for (const accountId of cashAccountIds) {
      if (config.accountsById.get(accountId)?.currency === 'CNY') valuation.queue(session, accountId, user);
    }
  }
  return entry;
}

// Cancels an entry with its mirror image. Dated like the original while that period is open,
// otherwise on the first open day. A reversal is never reversed itself.
// A reversal made by the historical migration carries its run id, like every entry of the run
async function reverseEntry(entryId, { session, user, reason, eventKey, eventType = 'REVERSAL', onLocked = 'shift', migrationRunId, isHistorical } = {}) {
  assertInTransaction(session);
  const original = await JournalEntry.findById(entryId).session(session);
  if (!original) throw new ErrorHandler(404, 'القيد غير موجود');
  if (original.reversalOf) throw new ErrorHandler(400, 'القيد العكسي لا يُلغى. لتصحيحه أنشئ مستنداً جديداً.');

  const key = eventKey || `REVERSE:${original._id}`;
  const already = await JournalEntry.findOne({ eventKey: key }).session(session);
  if (already) return already;
  if (original.status === 'reversed') throw new ErrorHandler(400, 'القيد مُلغى مسبقاً');

  const reversal = await postEntry({
    journalId: original.journalId,
    eventType,
    eventKey: key,
    date: original.day,
    description: `إلغاء القيد ${original.number}${reason ? ` - ${reason}` : ''}`,
    source: original.source,
    reversalOf: original._id,
    ...(migrationRunId && { migrationRunId, isHistorical: !!isHistorical }),
    // A live entry was already moved off a counted box if it had to be: it is undone line for line
    ...(!original.isHistorical && { countRule: 'skip' }),
    lines: original.lines.map((line) => {
      const plain = line.toObject ? line.toObject() : { ...line };
      return {
        ...plain,
        debit: plain.credit,
        credit: plain.debit,
        amountCurrency: plain.amountCurrency ? -plain.amountCurrency : plain.amountCurrency,
      };
    }),
  }, { session, user, onLocked });

  original.status = 'reversed';
  original.reversedBy = reversal._id;
  await original.save({ session });
  return reversal;
}

module.exports = { postEntry, reverseEntry, MAX_ROUNDING_CENTS };
