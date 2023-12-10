const { validatePhoneNumber } = require('../utils/messages');
const ErrorHandler = require('../utils/errorHandler');
const { Client } = require('whatsapp-web.js');

const client = new Client(); // Use a common client instance

client.on('ready', () => {
  console.log('WhatsApp client is ready! 2');
});

client.initialize();

// module.exports.sendWhatsupMessage = async (req, res, next) => {
//   const { phone, message, shouldVerifyQrCode } = req.body;

//     // generete
//     wbm
//     .start({ sendMessage: !shouldVerifyQrCode })
//     .then(async (qrCodeData) => {
//       if (shouldVerifyQrCode) {
//         res.status(200).send(qrCodeData);
//         wbm.waitQRCode();
//       } else {
//         const receiver = validatePhoneNumber(phone);
//         const phones = [receiver];
//         try {
//           await wbm.send(['905535728209'], message);
//           await wbm.end();
//         } catch (error) {
//           return next(new ErrorHandler(404, error.message));
//         }
//         res.status(200).send(qrCodeData)
//       }
//     })
//     .catch((err) => {
//       console.log("errrrrror", err);
//     });

//     // generete
//     // wbm
//     // .start({ qrCodeData: true, session: false, showBrowser: false })
//     // .then(async (qrCodeData) => {
//     //     res.send(qrCodeData);
//     //     await wbm.waitQRCode();

//     //     const receiver = validatePhoneNumber(phone);
//     //     const phones = [phone];
//     //     await wbm.send(['905535728209'], message);
//     //     await wbm.end();
//     //     res.status(200).send(qrCodeData)
//     // })
//     // .catch((err) => {
//     //   console.log("errrrrror", err);
//     //   return next(new ErrorHandler(404, err.message));
//     // });
// }

module.exports.sendWhatsupMessage = async (req, res, next) => {
  const { phone, message, shouldVerifyQrCode } = req.body;

  try {
    console.log(client.state);
    if (client.state === 'authenticated') {
      const target = await client.getContactById('+905535728209');
      console.log(target);
      // if (target) {
      //   await client.sendMessage(target.id._serialized, 'hello');
      //   return res.status(200).json({ success: true, message: 'Message sent successfully' });
      // } else {
      //   return res.status(400).json({ success: false, message: 'Contact not found' });
      // }
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

