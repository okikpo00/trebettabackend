// src/services/homeService.js
const billboardService = require('./billboardService');
const winnerTickerService = require('./winnerTickerService');

async function getHomePayload() {
  // returns both billboards (active) and winner ticker
  const [billboards, winners] = await Promise.all([
    billboardService.listBillboards({ onlyActive: true }),
    winnerTickerService.listWinners()
  ]);

  return { billboards, winner_ticker: winners };
}

module.exports = { getHomePayload };
