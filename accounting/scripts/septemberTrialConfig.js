const path = require('path');
const os = require('os');
const { isDay, addDays } = require('../services/dates');

const trialDate = process.env.EXIOS_TRIAL_DATE || '20261006';
const START = process.env.EXIOS_TRIAL_START || '2026-09-01';
if (!/^\d{8}$/.test(trialDate) || !isDay(START)) throw new Error('Invalid local trial date');
const TARGET = `exios-september-trial-${trialDate}`;
module.exports = { SOURCE: 'exios-prod-copy', TARGET, START, COUNT: addDays(START, -1),
  OUTPUT: path.join(os.homedir(), 'Downloads', `Exios-September-Trial-${trialDate}`),
  URI: `mongodb://127.0.0.1:27017/${TARGET}?directConnection=true` };
