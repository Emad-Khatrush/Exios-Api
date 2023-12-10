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

const checkIfPhoneValid = (phone) => {
  // check if it has 13 number
  if (phone.trim().length - 1 === 13) {
    return true;
  }
  return false;
}

module.exports = { validatePhoneNumber, checkIfPhoneValid };