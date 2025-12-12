// src/utils/sterlingSmsParser.js

/**
 * Example SMS:
 * Money In! NGN42,000.00 has arrived from CHINEMELUM IFECHUKWU NWACHUKWU into ******0089 at 2025-12-06 20:50:51. You have NGNxxxx
 */
function parseSterlingCreditSms(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, reason: 'invalid_message' };
  }

  const text = raw.trim();

  // quick guard – only handle Money In! credits
  if (!text.startsWith('Money In!')) {
    return { ok: false, reason: 'not_money_in' };
  }

  // regex to capture amount, name, last4, datetime
  const regex =
    /^Money In!\s*NGN([\d,]+(?:\.\d{2})?)\s+has arrived from\s+(.+?)\s+into\s+\*+(\d{4})\s+at\s+([\d\-: ]+)\./i;

  const match = text.match(regex);
  if (!match) {
    return { ok: false, reason: 'pattern_not_matched' };
  }

  const [, amountStr, senderNameRaw, last4, dateTimeStr] = match;

  const amount = Number(amountStr.replace(/,/g, ''));
  const sender_name = senderNameRaw.trim();
  const account_last4 = last4.trim();

  // Convert "2025-12-06 20:50:51" to Date
  const tx_time = new Date(dateTimeStr.replace(' ', 'T'));

  if (!amount || Number.isNaN(amount)) {
    return { ok: false, reason: 'bad_amount' };
  }

  return {
    ok: true,
    amount,
    sender_name,
    account_last4,
    tx_time: isNaN(tx_time.getTime()) ? null : tx_time,
  };
}

module.exports = {
  parseSterlingCreditSms,
};
