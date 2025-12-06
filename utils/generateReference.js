// utils/generateReference.js
const { v4: uuidv4 } = require('uuid');

function genRef(prefix = 'REF') {
  return `${prefix}_${Date.now()}_${uuidv4().split('-')[0]}`;
}

module.exports = genRef;
