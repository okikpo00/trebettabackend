const express = require("express");
const router = express.Router();

const publicBankCtrl = require("../controllers/publicBankController");

// Public endpoint (no auth required)
router.post("/bank/resolve", publicBankCtrl.resolveBank);

module.exports = router;
