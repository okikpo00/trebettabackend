const axios = require("axios");

exports.resolveBank = async (req, res) => {
  try {
    const { bank_code, account_number } = req.body;

    if (!bank_code || !account_number) {
      return res.status(400).json({
        status: false,
        message: "bank_code and account_number required"
      });
    }

    // Example public mirror API (works with many Nigerian banks)
    const url = `https://api.paystackmirror.com/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`;

    const response = await axios.get(url);

    if (!response.data || !response.data.status) {
      return res.status(400).json({
        status: false,
        message: "Could not verify bank account, please type it manually."
      });
    }

    return res.json({
      status: true,
      data: {
        bank_code,
        bank_name: response.data.data.bank_name,
        account_number,
        account_name: response.data.data.account_name
      }
    });

  } catch (err) {
    console.error("resolveBank error:", err?.response?.data || err.message);
    return res.status(400).json({
      status: false,
      message: "Bank account lookup failed, enter name manually."
    });
  }
};
