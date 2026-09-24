const fs = require('fs');
const path = require('path');
const { RemoteAuth } = require('whatsapp-web.js');

// Chrome compacts its IndexedDB LevelDB files while running, so copying the
// profile can hit ENOENT on a file deleted mid-copy. Retry, and never throw:
// the library calls this from a bare setInterval, where a rejection would be
// unhandled and crash the process.
class SafeRemoteAuth extends RemoteAuth {
  async storeRemoteSession(options, attempts = 4) {
    for (let i = 1; i <= attempts; i++) {
      try {
        await super.storeRemoteSession(options);
        return true;
      } catch (err) {
        if (i === attempts) {
          console.error(`WhatsApp session backup failed after ${attempts} attempts:`, err.message);
          return false;
        }
        await new Promise((r) => setTimeout(r, 3000 * i));
      }
    }
  }
}

// Replaces wwebjs-mongo's MongoStore, which reads `<session>.zip` from the cwd
// while whatsapp-web.js >=1.26 writes it into RemoteAuth's dataPath — so it
// silently uploaded an empty/stale zip and sessions never survived a restart.
class WhatsAppMongoStore {
  constructor({ mongoose, dataPath = './.wwebjs_auth/' }) {
    this.mongoose = mongoose;
    this.dataPath = path.resolve(dataPath);
  }

  bucket(session) {
    return new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
      bucketName: `whatsapp-${session}`,
    });
  }

  async sessionExists({ session }) {
    const count = await this.mongoose.connection.db
      .collection(`whatsapp-${session}.files`)
      .countDocuments({ filename: `${session}.zip`, length: { $gt: 0 } });
    return count > 0;
  }

  async save({ session }) {
    const zipPath = path.join(this.dataPath, `${session}.zip`);
    const { size } = await fs.promises.stat(zipPath);
    if (!size) throw new Error(`Refusing to save empty WhatsApp session zip: ${zipPath}`);

    const bucket = this.bucket(session);
    await new Promise((resolve, reject) => {
      fs.createReadStream(zipPath)
        .on('error', reject)
        .pipe(bucket.openUploadStream(`${session}.zip`))
        .on('error', reject)
        .on('finish', resolve);
    });

    // Keep only the newest backup.
    const docs = await bucket
      .find({ filename: `${session}.zip` })
      .sort({ uploadDate: -1 })
      .toArray();
    await Promise.all(docs.slice(1).map((d) => bucket.delete(d._id)));
  }

  async extract({ session, path: outPath }) {
    const bucket = this.bucket(session);
    const [latest] = await bucket
      .find({ filename: `${session}.zip`, length: { $gt: 0 } })
      .sort({ uploadDate: -1 })
      .limit(1)
      .toArray();
    if (!latest) throw new Error('No WhatsApp session backup found');

    // Fresh Heroku dynos start without .wwebjs_auth, and RemoteAuth only
    // creates it when there's no remote session to restore.
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

    await new Promise((resolve, reject) => {
      bucket.openDownloadStream(latest._id)
        .on('error', reject)
        .pipe(fs.createWriteStream(outPath))
        .on('error', reject)
        .on('close', resolve);
    });
  }

  async delete({ session }) {
    const bucket = this.bucket(session);
    const docs = await bucket.find({ filename: `${session}.zip` }).toArray();
    await Promise.all(docs.map((d) => bucket.delete(d._id)));
  }
}

module.exports = { WhatsAppMongoStore, SafeRemoteAuth };
