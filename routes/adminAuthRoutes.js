// routes/adminAuthRoutes.js
const express = require('express');
const router = express.Router();

const adminAuth = require('../controllers/adminAuthController');
const requireAdmin = require('../middleware/requireAdmin');

const { authLimiter } = require('../middleware/rateLimiter'); // NEW

// -----------------------------------------------------
// PUBLIC ROUTES (RATE LIMITED)
// -----------------------------------------------------
router.post('/login', authLimiter, adminAuth.login);
router.post('/forgot-password', authLimiter, adminAuth.forgotPassword);
router.post('/reset-password', authLimiter, adminAuth.resetPassword);

// -----------------------------------------------------
// PROTECTED ROUTES (NEED ADMIN TOKEN + SESSION ID)
// -----------------------------------------------------
router.post('/logout', requireAdmin, adminAuth.logout);
router.get('/profile', requireAdmin, adminAuth.profile);

module.exports = router;