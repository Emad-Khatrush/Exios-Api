const { Storage } = require("@google-cloud/storage");
const { format } = require('util');
const { v4: uuidv4 } = require('uuid');

let projectId =  process.env.GOOGLE_PROJECT_NUMBER;
let keyFilename = "sonic-shuttle-310011-b426b461aa9e.json";
const storage = new Storage({
  projectId,
  keyFilename,
});

const bucket = storage.bucket(process.env.GOOGLE_BUCKET_ID);

const uploadToGoogleCloud = async (file, folderName) => {
  try {
    const cloudFile  = await bucket.file(file.originalname);
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
