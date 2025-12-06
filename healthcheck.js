const axios = require("axios");

const BASE_URL = "http://localhost:5000/api";

async function healthCheck() {
  try {
    // 1. Register
    let registerRes = await axios.post(`${BASE_URL}/auth/register`, {
      first_name: "Check",
      last_name: "Bot",
      username: "checkbot",
      phone: "+2348011111111",
      email: "checkbot@example.com",
      password: "Test12345"
    });
    console.log("✅ Register OK:", registerRes.data);

    // 2. Login
    let loginRes = await axios.post(`${BASE_URL}/auth/login`, {
      identifier: "checkbot",
      password: "Test12345"
    });
    console.log("✅ Login OK");
    const token = loginRes.data.accessToken;

    // 3. Get Wallet
    let walletRes = await axios.get(`${BASE_URL}/wallet`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log("✅ Wallet:", walletRes.data);

    // 4. List Bets
    let betsRes = await axios.get(`${BASE_URL}/bets`);
    console.log("✅ Bets:", betsRes.data);

    // 5. Winner Ticker
    let tickerRes = await axios.get(`${BASE_URL}/ui/ticker/latest`);
    console.log("✅ Ticker:", tickerRes.data);
  } catch (err) {
    console.error("❌ Health check failed:", err.response?.data || err.message);
  }
}

healthCheck();
