const { Storage } = require("@google-cloud/storage");
const { format } = require('util');
const { v4: uuidv4 } = require('uuid');
const { getRandomChars } = require('./messages')

let projectId =  process.env.GOOGLE_PROJECT_NUMBER;

const storage = new Storage({
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

const bucket = storage.bucket(process.env.GOOGLE_BUCKET_ID);

const uploadToGoogleCloud = async (file, folderName) => {
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

module.exports = { uploadToGoogleCloud };
