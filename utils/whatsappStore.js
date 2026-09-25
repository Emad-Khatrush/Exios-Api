const fs = require('fs');
const path = require('path');
const { RemoteAuth } = require('whatsapp-web.js');

class SafeRemoteAuth extends RemoteAuth {
  constructor(options) {
    super(options);
    // RemoteAuth only backs up 'Local Storage' (a folder), but newer Chrome
    // (e.g. Heroku's Chrome for Testing) stores it as a 'LocalStorage' SQLite
    // file plus a 'WebStorage' folder. Without these the restored profile has
    // no WhatsApp localStorage, so it shows a QR again. Missing ones are skipped.
    this.requiredDirs = [
      ...this.requiredDirs,
      'LocalStorage',
      'LocalStorage-wal',
      'LocalStorage-shm',
      'LocalStorage-journal',
      'WebStorage',
    ];
  }

  // whatsapp-web.js calls disconnect() on transient states too (CONFLICT,
  // UNLAUNCHED, UNPAIRED_IDLE), and the stock version deletes the saved
  // session from Mongo — so one hiccup forced a new QR scan. Only a real
  // logout (logout() below) wipes it now.
  async disconnect() {
    clearInterval(this.backupSync);
  }

  async logout() {
    await super.disconnect();
  }

  // The stock version backs up the profile while Chrome is running (a
  // half-written copy) 60s after login. The app takes clean snapshots itself.
  async afterAuthReady() {}

  // Zips the (already closed) Chrome profile and keeps it as the local
  // snapshot. Fast (~1s), so Chrome can restart from it straight away.
  async snapshotSession() {
    const pathExists = await this.isValidPath(this.userDataDir);
    if (!pathExists) return false;
    let zipPath;
    try {
      zipPath = await this.compressSession();
      await this.store.cacheSnapshot({ session: this.sessionName, zipPath });
      return true;
    } catch (err) {
      console.error('WhatsApp session snapshot failed:', err.message);
      return false;
    } finally {
      await Promise.allSettled(
        [this.tempDir, zipPath].filter(Boolean).map((p) =>
          fs.promises.rm(p, { recursive: true, force: true, maxRetries: this.rmMaxRetries }),
        ),
      );
    }
  }

  // Uploads the local snapshot to Mongo. Slow on this database (~3 min for
  // ~17MB), so callers run it in the background. Never throws.
  async uploadSnapshot(attempts = 3) {
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.store.uploadSnapshot({ session: this.sessionName });
        return true;
      } catch (err) {
        if (i === attempts) {
          console.error(`WhatsApp session upload failed after ${attempts} attempts:`, err.message);
          return false;
        }
        await new Promise((r) => setTimeout(r, 5000 * i));
      }
    }
  }

  // Called by the library's periodic timer; kept safe in case it ever fires.
  async storeRemoteSession() {
    return (await this.snapshotSession()) && this.uploadSnapshot();
  }
}

// GridFS-backed session store. Keeps the newest snapshot this process made on
// local disk too, so a reconnect restores from it instantly instead of waiting
// minutes to download from Mongo (and gets it even while the upload of that
// same snapshot is still in progress).
class WhatsAppMongoStore {
  constructor({ mongoose, dataPath = './.wwebjs_auth/' }) {
    this.mongoose = mongoose;
    this.dataPath = path.resolve(dataPath);
    this.cachedSessions = new Set();
  }

  bucket(session) {
    return new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
      bucketName: `whatsapp-${session}`,
    });
  }

  cachePath(session) {
    return path.join(this.dataPath, `${session}.snapshot.zip`);
  }

  async cacheSnapshot({ session, zipPath }) {
    const { size } = await fs.promises.stat(zipPath);
    if (!size) throw new Error(`Refusing to keep empty WhatsApp session zip: ${zipPath}`);
    await fs.promises.copyFile(zipPath, this.cachePath(session));
    this.cachedSessions.add(session);
  }

  async sessionExists({ session }) {
    if (this.cachedSessions.has(session)) return true;
    const count = await this.mongoose.connection.db
      .collection(`whatsapp-${session}.files`)
      .countDocuments({ filename: `${session}.zip`, length: { $gt: 0 } });
    return count > 0;
  }

  async uploadSnapshot({ session }) {
    if (!this.cachedSessions.has(session)) throw new Error('No local WhatsApp snapshot to upload');
    // Upload a private copy so a newer snapshot can't overwrite it mid-upload.
    const uploadPath = path.join(this.dataPath, `${session}.uploading.zip`);
    await fs.promises.copyFile(this.cachePath(session), uploadPath);
    const bucket = this.bucket(session);
    try {
      await new Promise((resolve, reject) => {
        fs.createReadStream(uploadPath)
          .on('error', reject)
          .pipe(bucket.openUploadStream(`${session}.zip`))
          .on('error', reject)
          .on('finish', resolve);
      });
    } finally {
      await fs.promises.rm(uploadPath, { force: true });
    }

    // Keep only the newest backup, and drop chunks left behind by uploads that
    // were killed half-way (they have no matching files document).
    const docs = await bucket.find({ filename: `${session}.zip` }).sort({ uploadDate: -1 }).toArray();
    await Promise.all(docs.slice(1).map((d) => bucket.delete(d._id)));
    await this.mongoose.connection.db
      .collection(`whatsapp-${session}.chunks`)
      .deleteMany({ files_id: { $nin: [docs[0]._id] } });
  }

  async extract({ session, path: outPath }) {
    // Fresh Heroku dynos start without .wwebjs_auth, and RemoteAuth only
    // creates it when there's no remote session to restore.
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

    if (this.cachedSessions.has(session)) {
      await fs.promises.copyFile(this.cachePath(session), outPath);
      return;
    }

    const bucket = this.bucket(session);
    const [latest] = await bucket
      .find({ filename: `${session}.zip`, length: { $gt: 0 } })
      .sort({ uploadDate: -1 })
      .limit(1)
      .toArray();
    if (!latest) throw new Error('No WhatsApp session backup found');

    const started = Date.now();
    console.log(`Downloading WhatsApp session from MongoDB (${(latest.length / 1048576).toFixed(1)}MB)...`);
    await new Promise((resolve, reject) => {
      bucket.openDownloadStream(latest._id)
        .on('error', reject)
        .pipe(fs.createWriteStream(outPath))
        .on('error', reject)
        .on('close', resolve);
    });
    console.log(`WhatsApp session downloaded in ${((Date.now() - started) / 1000).toFixed(0)}s.`);
  }

  async delete({ session }) {
    this.cachedSessions.delete(session);
    await fs.promises.rm(this.cachePath(session), { force: true });
    const bucket = this.bucket(session);
    const docs = await bucket.find({ filename: `${session}.zip` }).toArray();
    await Promise.all(docs.map((d) => bucket.delete(d._id)));
  }
}

module.exports = { WhatsAppMongoStore, SafeRemoteAuth };
