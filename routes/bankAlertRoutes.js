const express = require('express');
const router = express.Router();
const bankAlertCtrl = require('../controllers/bankAlertController');

// public, but protected with x-sms-secret
router.post('/sms-alert', bankAlertCtrl.receiveBankSms);

module.exports = router;
