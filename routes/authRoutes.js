// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const auth = require('../controllers/authController');
const { body } = require('express-validator');

// Register
router.post('/register',
  [
    body('email').isEmail().withMessage('valid email required'),
    body('password').isLength({ min: 8 }),
    body('fullName').notEmpty()
  ],
  auth.register);

// Verify email
router.post('/verify-email', auth.verifyEmail);

// Login
router.post('/login',
  [
    body('identifier').notEmpty(),
    body('password').notEmpty()
  ],
  auth.login);

// Refresh (cookie or body)
router.post('/refresh', auth.refresh);

// Logout
router.post('/logout', auth.logout);

// Forgot / Reset
router.post('/forgot-password', auth.forgotPassword);
router.post('/reset-password', auth.resetPassword);

module.exports = router;

