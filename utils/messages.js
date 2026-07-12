const axios = require('axios');

const validatePhoneNumber = (phone) => {
  let cleanPhone = `${phone}`.trim();

  // 1. Handle your specific hardcoded case safely for Baileys
  if (cleanPhone.includes('5535728209')) {
      return '905535728209@s.whatsapp.net';
  }

  // 2. Strip any existing WhatsApp domain suffixes if passed in
  cleanPhone = cleanPhone.split('@')[0];

  // 3. Strip international indicators (+ or 00)
  if (cleanPhone.startsWith('+')) {
      cleanPhone = cleanPhone.substring(1);
  } else if (cleanPhone.startsWith('00')) {
      cleanPhone = cleanPhone.substring(2);
  }

  // 4. Define specific Libyan mobile patterns (Carrier prefixes: 91, 92, 93, 94, 95)
  const isLibyanLocalWithZero = /^09[1-5]\d{7}$/.test(cleanPhone);  // Matches: 091XXXXXXX (10 digits)
  const isLibyanLocalNoZero   = /^9[1-5]\d{7}$/.test(cleanPhone);    // Matches: 91XXXXXXX (9 digits)
  const isAlreadyLibyanIntl   = /^2189[1-5]\d{7}$/.test(cleanPhone); // Matches: 21891XXXXXXX (12 digits)

  // 5. Apply formatting logic based on the match
  if (isLibyanLocalWithZero) {
      // Remove the leading '0' and prepend Libyan country code '218'
      cleanPhone = '218' + cleanPhone.substring(1);
  } 
  else if (isLibyanLocalNoZero) {
      // Prepend '218' directly
      cleanPhone = '218' + cleanPhone;
  }

  // 6. Return the clean string formatted as a Baileys JID
  return `${cleanPhone}@s.whatsapp.net`;
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