// QA must never connect to the live database or dispatch live messages.
const isQa = process.env.EXIOS_QA === '1';
if (isQa) {
  const connectionUrl = process.env.MONGO_URL_2 || process.env.MONGO_URL || '';
  let hostname;
  try { hostname = new URL(connectionUrl).hostname; } catch (_) {}
  if (hostname !== 'exios-api-qa.ian5mmn.mongodb.net') {
    throw new Error('EXIOS_QA requires the dedicated Exios QA MongoDB cluster.');
  }
  process.env.BACKUP_BUCKET = '';
}
module.exports = { isQa };
