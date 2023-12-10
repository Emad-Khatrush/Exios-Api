const { MailtrapClient } = require("mailtrap");
const handlebars = require("handlebars");
const fs = require("fs");
const path = require("path");
const PDFDocument = require('pdfkit');

const arabicFontPath = 'NotoSansArabic.ttf';

const sendEmail = async (email, subject, payload, template) => {
  const TOKEN = process.env.EMAIL_PASSWORD;
  const ENDPOINT = "https://send.api.mailtrap.io/";

  const client = new MailtrapClient({ endpoint: ENDPOINT, token: TOKEN });

  const sender = {
    email: "service@exioslibya.com",
    name: "Exios Company",
  };
  const recipients = [
    {
      email,
    }
  ];

  const source = fs.readFileSync(path.join(__dirname, template), "utf8");
  const compiledTemplate = handlebars.compile(source);

  client
    .send({
      from: sender,
      to: recipients,
      subject,
      html: compiledTemplate(payload),
    })
    .then(console.log, console.error)
}

// ****************** nodemailer code ************************ 

// const sendEmail = async (email, subject, payload, template) => {
//   try {
//     // create reusable transporter object using the default SMTP transport
//     const transporter = await nodemailer.createTransport({
//       host: process.env.EMAIL_HOST,
//       port: 587,
//       auth: {
//         user: process.env.EMAIL_USERNAME,
//         pass: process.env.EMAIL_PASSWORD, // naturally, replace both with your real credentials or an application-specific password
//       },
//     });

//     const source = fs.readFileSync(path.join(__dirname, template), "utf8");
//     const compiledTemplate = handlebars.compile(source);
//     const options = () => {
//       return {
//         from: process.env.FROM_EMAIL,
//         to: email,
//         subject: subject,
//         html: compiledTemplate(payload),
//       };
//     };

//     // Send email
//     transporter.sendMail(options(), (error, info) => {
//       if (error) {
//         console.log(error);
//         return error;
//       } else {
//         console.log(info);

//         return true
//       }
//     });
//   } catch (error) {
//     console.log("outside ", error);
//     return error;
//   }
// };

/*
Example:
sendEmail(
  "youremail@gmail.com,
  "Email subject",
  { name: "Eze" },
  "./templates/layouts/main.handlebars"
);
*/

async function generatePDF(data) {
  // Create a new PDF document
  const doc = new PDFDocument({ lang: 'arabic' });

  // Pipe the PDF document to a writable stream (file stream in this example)
  const outputStream = fs.createWriteStream('users_without_orders.pdf');
  doc.pipe(outputStream);
  
  // Add content to the PDF
  doc.font('Helvetica').fontSize(16).text('Users without Orders', { align: 'center' });
  doc.moveDown();

  // Iterate over the data and add it to the PDF
  data.forEach((user) => {
    doc.font('Courier').fontSize(12).text(`Full Name: ${user.firstName} ${user.lastName}`, {features: ['rtla']});
    doc.font(arabicFontPath).fontSize(12).text(`${user.firstName} ${user.lastName}`, {features: ['rtla']});
    doc.font('Courier').fontSize(12).text(`Customer Id: ${user.customerId}`);
    doc.font('Courier').fontSize(12).text(`City: ${user.city}`);
    doc.font('Courier').fontSize(12).text(`phone number: ${user.phone}`);
    doc.font('Courier').fontSize(12).text('------------------------');
    doc.moveDown();
  });

  // Finalize the PDF and end the stream
  doc.end();

  console.log('PDF generated successfully.');
}

module.exports = { sendEmail, generatePDF };
