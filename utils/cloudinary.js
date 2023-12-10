// const cloudinary = require('cloudinary').v2;
// const { CloudinaryStorage } = require('multer-storage-cloudinary');
// const streamifier = require('streamifier');

// cloudinary.config({
//     cloud_name: process.env.CLOUDINARY_NAME,
//     api_key: process.env.CLOUDINARY_API_KEY,
//     api_secret: process.env.CLOUDINARY_API_SECRET,
// });

// // const storage = new CloudinaryStorage({
// //     cloudinary,
// //     params: {
// //       allowedFormats: ['jpeg', 'png', 'jpg']
// //     }
// //   });

// let uploadFromBuffer = async (file, folderName) => {

//   return new Promise((resolve, reject) => {

//     let cld_upload_stream = cloudinary.uploader.upload_stream(
//      {
//        folder: folderName
//      },
//      (error, result) => {

//        if (result) {
//          resolve(result);
//        } else {
//          reject(error);
//         }
//       }
//     );

//     streamifier.createReadStream(file.buffer).pipe(cld_upload_stream);
//   });

// };

// module.exports = { cloudinary, uploadFromBuffer };
