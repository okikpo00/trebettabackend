// routes/userRoutes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth'); // your auth middleware
const userController = require('../controllers/userController');

router.get('/me', auth, userController.getMe);
router.put('/me', auth, userController.updateProfile);
router.post('/change-password', auth, userController.changePassword);

module.exports = router;
