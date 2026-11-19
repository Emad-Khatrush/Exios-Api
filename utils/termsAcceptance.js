// Which version of the company's terms each customer agreed to, so it can be shown later who agreed to
// what and when. TERMS_VERSION is the version in force: raise it, together with the client's terms
// (public/terms.pdf and TERMS_VERSION in TermsAndPrivacy/terms.ts), when the terms change, and every
// customer is asked to agree again on their next visit.
const TERMS_VERSION = '2.0';

const VERSION_TEXT = /^\d{1,3}(\.\d{1,3}){0,2}$/;

// One agreement: the version the customer was shown (the current one if what was sent is not a plain
// version number), how they agreed ('signup' or 'prompt'), when, and from which address and browser.
const acceptanceRecord = (version, via, req, at = new Date()) => ({
  version: typeof version === 'string' && VERSION_TEXT.test(version) ? version : TERMS_VERSION,
  via,
  acceptedAt: at,
  ip: req?.ip || '',
  userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300),
});

const acceptedVersion = (user) => {
  const list = user?.termsAcceptance || [];
  return list.length ? list[list.length - 1].version : null;
};

// Accounts from before versions were recorded (only isAgreeToTermsOfCompany) are asked once too
const termsStatus = (user) => {
  const accepted = acceptedVersion(user);
  return { current: TERMS_VERSION, accepted, needsAcceptance: accepted !== TERMS_VERSION };
};

module.exports = { TERMS_VERSION, acceptanceRecord, acceptedVersion, termsStatus };
