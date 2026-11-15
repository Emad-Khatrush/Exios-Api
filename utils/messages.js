const axios = require('axios');

// Any stored or typed phone -> a whatsapp-web.js ID (218912345678@c.us).
//   - Libyan mobiles (91-95) in any form: 912345678, 0912345678, 218912345678, +218 91..., 2180912345678
//   - Every other number is expected with its country code (905321234567, +971 50..., 00971...) and kept as is
//   - Spaces, dashes, brackets and Arabic/Persian digits are tolerated
const validatePhoneNumber = (phone) => {
  let p = `${phone ?? ''}`.split('@')[0]
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/\D/g, '');

  if (p.startsWith('00')) p = p.slice(2);

  // Test-mode number (Turkish), stored without its country code
  if (p === '5535728209') return '905535728209@c.us';

  if (/^2180\d{9}$/.test(p)) p = `218${p.slice(4)}`;          // 218 + local 0: 2180912345678
  if (/^09[1-5]\d{7}$/.test(p)) p = `218${p.slice(1)}`;       // 0912345678
  else if (/^9[1-5]\d{7}$/.test(p)) p = `218${p}`;            // 912345678

  return `${p}@c.us`;
};

const formatPhoneNumber = (phone) => {
  let generatePhone = phone.trim();

  // if phone number is starts with +
  if (generatePhone.startsWith('+')) {
    generatePhone =  generatePhone.substring(1);
  }
  // if phone number is starts with 00
  if (generatePhone.startsWith('00')) {
    generatePhone = generatePhone.substring(2);
  }
  if (generatePhone.startsWith('218')) {
    generatePhone =  generatePhone.substring(3);
  }
  // if phone number is starts with 0
  if (generatePhone.startsWith('0')) {
    generatePhone = generatePhone.substring(1);
  }
  return generatePhone;
};

const checkIfPhoneValid = (phone) => {
  // check if it has 13 number
  if (phone.trim().length - 1 === 13) {
    return true;
  }
  return false;
}

// Function to convert image to Base64
const imageToBase64 = async (url) => {
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const base64Data = Buffer.from(response.data, 'binary').toString('base64');
    return base64Data;
  } catch (error) {
    console.error('Error fetching image:', error);
    throw error;
  }
}

const getRandomChars = (length) => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

function getRandomStep(min, max, step) {
    // Calculate how many steps are possible
    const numSteps = Math.floor((max - min) / step) + 1;

    // Generate a random index within the number of steps
    const randomIndex = Math.floor(Math.random() * numSteps);

    // Return the value at that step
    return min + (randomIndex * step);
}

const replaceWords = (text, replacements) => {
  // Regular expression to match |word|
  const regex = /\|(\w+)\|/g;
  
  // Replace each match with corresponding value from replacements object
  const replacedText = text.replace(regex, (match, word) => {
      // Check if replacements object has the key
      if (replacements.hasOwnProperty(word)) {
          return replacements[word];
      } else {
          // If replacement not found, return original match
          return match;
      }
  });
  
  return replacedText;
}

module.exports = { formatPhoneNumber, validatePhoneNumber, checkIfPhoneValid, imageToBase64, getRandomChars, replaceWords, getRandomStep };