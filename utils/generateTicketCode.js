// utils/generateTicketCode.js
module.exports = function generateTicketCode(prefix = 'TRE') {
  const ts = Date.now().toString(36);
  const rnd = Math.floor(Math.random() * 1e6).toString(36);
  return `${prefix}-${ts}-${rnd}`.toUpperCase().slice(0, 32);
};
