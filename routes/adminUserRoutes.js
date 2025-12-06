// routes/adminUserRoutes.js
const express = require('express');
const router = express.Router();
const adminUser = require('../controllers/adminUserController');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

router.get('/', requireAuth, requireAdmin, adminUser.getUsers);


// 🧠 Get all users (paginated, searchable, filterable)
router.get('/export', requireAuth, requireAdmin, adminUser.exportUsers);

// 👁️ Get single user details
router.get('/:id', requireAuth, requireAdmin, adminUser.getUserDetails);

// 🚦 Suspend or Unsuspend user
router.patch('/status/:id', requireAuth, requireAdmin, adminUser.updateUserStatus);

// 🧩 Approve or Reject KYC (redirects frontend to KYC section)
router.patch('/kyc/:id', requireAuth, requireAdmin, adminUser.updateUserKYC);

// 🔑 Send password reset email
router.patch('/reset-password/:id', requireAuth, requireAdmin, adminUser.resetUserPassword);

// 🗑️ Soft delete user (mark as deleted)
router.delete('/:id', requireAuth, requireAdmin, adminUser.deleteUser);

module.exports = router;

