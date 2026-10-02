// Offices are data (spec 7-أ.4, phase C4): the list is accounting's offices, so an office added
// there is accepted across the system without a code change. The values the system has always
// used stay valid for old records.
const mongoose = require('mongoose');

const LEGACY = ['tripoli', 'benghazi', 'misurata', 'turkey', 'china'];
const TTL = 60 * 1000;
let cache = { at: 0, list: null };

// [{ code, name, nameEn, country }] of the active offices
async function officeList() {
  if (cache.list && Date.now() - cache.at < TTL) return cache.list;
  let list = [];
  try {
    const Office = mongoose.models.AccountingOffice || require('../accounting/models').AccountingOffice;
    list = await Office.find({ isActive: { $ne: false } }).select('code name nameEn country').sort({ createdAt: 1 }).lean();
  } catch {
    list = [];
  }
  if (!list.length) list = LEGACY.map((code) => ({ code, name: code }));
  cache = { at: Date.now(), list };
  return list;
}

async function officeCodes() {
  return [...new Set([...LEGACY, ...(await officeList()).map((office) => office.code)])];
}

const invalidateOffices = () => { cache = { at: 0, list: null }; };

// A schema validator: empty, one of `extra` (old values of that field), or a known office
const officeValidator = (extra = []) => ({
  validator: async (value) => !value || extra.includes(value) || (await officeCodes()).includes(value),
  message: (props) => `Unknown office "${props.value}"`,
});

module.exports = { officeList, officeCodes, officeValidator, invalidateOffices, LEGACY_OFFICES: LEGACY };
