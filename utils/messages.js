const axios = require('axios');

const validatePhoneNumber = (phone) => {
  let generatePhone = phone.trim();
  if (generatePhone === '5535728209@c.us') {
    return '90' + generatePhone;
  }
  // if phone number is starts with +
  if (generatePhone.startsWith('+')) {
    generatePhone =  generatePhone.substring(1);
  }
  // if phone number is starts with 00
  if (generatePhone.startsWith('00')) {
    generatePhone = generatePhone.substring(2);
  }
  // if phone number is starts with 0
  if (generatePhone.startsWith('0')) {
    generatePhone = '218' + generatePhone.substring(1);
  }
  // if phone number is starts with 9
  if (generatePhone.startsWith('9')) {
    generatePhone = '218' + generatePhone;
  }
  return generatePhone;
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