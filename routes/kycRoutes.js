// routes/kycRoutes.js
const express = require('express');
const router = express.Router();
const kycController = require('../controllers/kycController');
const { upload, kycUploadHandler } = require('../middleware/uploadMiddleware');
const requireAuth = require('../middleware/auth');

// submit KYC: multipart (document + selfie)
router.post('/submit',
  requireAuth,
  upload.fields([{ name: 'document', maxCount: 1 }, { name: 'selfie', maxCount: 1 }]),
  kycUploadHandler,
  kycController.submitKyc
);

router.get('/status', requireAuth, kycController.getKycStatus);

module.exports = router;
