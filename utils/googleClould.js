const { Storage } = require("@google-cloud/storage");
const { isQa } = require('./qaEnvironment');
const { format } = require('util');
const { v4: uuidv4 } = require('uuid');
const { getRandomChars } = require('./messages')

let projectId =  process.env.GOOGLE_PROJECT_NUMBER;

const storage = new Storage(isQa ? {} : {
  projectId,
  credentials: {
  "type": "service_account",
  "project_id": "sonic-shuttle-310011",
  "private_key_id": process.env.GOOGLE_SECRET_KEY_ID,
  "private_key": process.env.GOOGLE_SECRET_KEY.replace(/\\n/g, '\n'),
  "client_email": "exios-641@sonic-shuttle-310011.iam.gserviceaccount.com",
  "client_id": "115109869051641604976",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/exios-641%40sonic-shuttle-310011.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
  },
});

const bucket = isQa ? null : storage.bucket(process.env.GOOGLE_BUCKET_ID);

const uploadToGoogleCloud = async (file, folderName) => {
  if (isQa) return require('./qaFiles').upload(file, folderName);
  try {
    const cloudFile  = await bucket.file(getRandomChars(10) + file.originalname);
    const blobStream = cloudFile.createWriteStream({
      resumable: false
    });

    blobStream.on("finish", () => {
      console.log("success");
    });

    blobStream.on("error", (err) => {
      console.log("err=====", err);
    });

    const publicUrl = format(
      `https://storage.googleapis.com/${bucket.name}/${cloudFile.name}`
    );
    
    await blobStream.end(file.buffer);

    return {
      publicUrl,  
      filename: uuidv4(),
      folder: '/' + folderName
    };
  } catch (error) {
    console.log(error);
    return {}
  }
};

// Removes an object previously returned by uploadToGoogleCloud, given its public URL.
const deleteFromGoogleCloud = async (publicUrl) => {
  if (isQa) return require('./qaFiles').remove(publicUrl);
  const prefix = `https://storage.googleapis.com/${bucket.name}/`;
  if (typeof publicUrl !== 'string' || !publicUrl.startsWith(prefix)) return;
  try {
    await bucket.file(publicUrl.substring(prefix.length)).delete({ ignoreNotFound: true });
  } catch (error) {
    console.log(error);
  }
};

// A short download link for a file of our bucket, given its public URL. The bucket does not let the
// browser read files itself (no CORS), so the "Download" button of the file viewer opened a new
// tab; this link carries "attachment", so the browser saves the file and stays on the page.
// Only objects of our own bucket are signed, never another address.
const downloadUrlFor = async (publicUrl, filename) => {
  if (isQa) return publicUrl;
  const prefix = `https://storage.googleapis.com/${bucket.name}/`;
  if (typeof publicUrl !== 'string' || !publicUrl.startsWith(prefix)) return null;
  const raw = publicUrl.substring(prefix.length).split('?')[0].split('#')[0];
  if (!raw) return null;
  // Saved names are raw ("abc123فاتورة 1.pdf"); a URL from the browser may arrive encoded
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch (e) { /* keep raw */ }
  let file = bucket.file(raw);
  if (!(await file.exists())[0]) {
    if (decoded === raw || !(await bucket.file(decoded).exists())[0]) return null;
    file = bucket.file(decoded);
  }
  let name = String(filename || file.name.split('/').pop() || 'file').replace(/[\r\n"]/g, '').slice(0, 200) || 'file';
  // Uploads are often saved under a bare id ("af4b48bc-..."): without its extension the saved file
  // would not open, so it gets one from its type
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
    const type = String((await file.getMetadata())[0].contentType || '').split(';')[0].toLowerCase();
    const ext = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc' }[type]
      || (/^(image|video|audio)\/([a-z0-9]+)$/.exec(type) || [])[2];
    if (ext) name = `${name}.${ext}`;
  }
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 5 * 60 * 1000,
    responseDisposition: `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  return url;
};

module.exports = { storage, uploadToGoogleCloud, deleteFromGoogleCloud, downloadUrlFor };
