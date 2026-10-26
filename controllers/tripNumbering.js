const { TripNumberingRule: Rule } = require('../models/tripNumbering');
const Inventory = require('../models/inventory');
const Activities = require('../models/activities');
const ErrorHandler = require('../utils/errorHandler');
const numbering = require('../utils/tripNumbering');
const { runInTransaction } = require('../accounting/services/transaction');

exports.list = async (req, res, next) => {
  try {
    const countries = Inventory.schema.path('shippedCountry').enumValues.map(value => ({ value, label: numbering.COUNTRY_NAMES[value] || value }));
    const stored = await Rule.find().lean();
    const byId = new Map(stored.map(rule => [rule._id, rule]));
    const rules = (await Promise.all(countries.map(async country => {
      return Promise.all(numbering.KINDS.map(async kind => {
        const identity = numbering.scopeFromKind(country.value, kind.value);
        const rule = byId.get(identity._id) || numbering.defaults(identity);
        return { ...rule, nameTemplate: numbering.normalizeTemplate(rule.nameTemplate), ...(await numbering.nextAvailable(rule)) };
      }));
    }))).flat();
    res.json({ countries, kinds: numbering.KINDS, rules, token: numbering.TOKEN });
  } catch (error) { next(error); }
};

exports.preview = async (req, res, next) => {
  try {
    const identity = numbering.scope(String(req.query.country || ''), String(req.query.shippingType || ''), req.query.seaLoadType || null);
    const rule = await numbering.preview(identity);
    // Staff get only the current creation preview; they cannot read/edit the settings.
    res.json({ enabled: rule.enabled, voyage: rule.enabled ? rule.voyage : '', nextNumber: rule.enabled ? rule.nextNumber : null });
  } catch (error) { next(error); }
};

exports.save = async (req, res, next) => {
  try {
    const identity = numbering.scopeFromKind(req.params.country, req.params.kind);
    const input = numbering.validate(req.body, identity);
    if (!Number.isSafeInteger(req.body.version) || req.body.version < 0) throw new ErrorHandler(400, 'Invalid settings version. Reload the page.');
    await numbering.ensureRule(identity);
    const outcome = await runInTransaction(async session => {
      const before = await Rule.findById(identity._id).session(session).lean();
      if (before.version !== req.body.version) throw new ErrorHandler(409, 'Another admin changed these settings. Reload them before saving.');
      const available = await numbering.nextAvailable(input, session);
      if (input.nextNumber < available.highestNumber + 1) throw new ErrorHandler(409, `This number has already been used. The next available number is ${available.highestNumber + 1}. Update the number and save again.`);
      const { _id, ...fields } = input;
      const saved = await Rule.findOneAndUpdate({ _id: identity._id, version: before.version }, {
        $set: { ...fields, updatedBy: req.user._id }, $inc: { version: 1, mutationVersion: 1 },
      }, { new: true, session, runValidators: true }).lean();
      if (!saved) throw new ErrorHandler(409, 'The settings have changed. Reload the page.');
      await Activities.create([{
        user: req.user._id,
        details: { path: '/settings/trip-numbering', status: 'updated', type: 'inventory', actionId: identity._id },
        changedFields: [{ label: 'Trip numbering', value: JSON.stringify({ country: identity.country, kind: identity.kind, before, after: saved }) }],
      }], { session });
      return { ...saved, ...(await numbering.nextAvailable(saved, session)) };
    });
    res.json(outcome);
  } catch (error) { next(error); }
};
