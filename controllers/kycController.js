// controllers/kycController.js
const pool = require('../config/db');
const { auditLog } = require('../utils/auditLog');
const notify = require('../utils/notify');

/**
 * Safe wrapper around auditLog so it never crashes the request
 */
async function safeAuditLog(adminId, userId, action, entity, entityId, details) {
  try {
    await auditLog(adminId, userId, action, entity, entityId, details);
  } catch (err) {
    console.warn('auditLog failed (ignored):', err.message);
  }
}

/**
 * Safe wrapper around notify so it never crashes the request
 */
async function safeNotify(payload) {
  try {
    await notify(payload);
  } catch (err) {
    console.warn('notify failed (ignored):', err.message);
  }
}

/**
 * POST /api/kyc/submit
 * Body (JSON):
 * {
 *   document_type: "NIN_SLIP",
 *   document_url: "https://...",
 *   document_url_back: "https://...",
 *   selfie_url: "https://..."
 * }
 */
exports.submitKyc = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res
      .status(401)
      .json({ status: false, message: 'Unauthorized' });
  }

  const {
    document_type,
    document_url,
    document_url_back,
    selfie_url
  } = req.body || {};

  console.log('KYC BODY:', req.body);

  // 1) Basic validation
  if (!document_type) {
    return res
      .status(400)
      .json({ status: false, message: 'Document type is required' });
  }

  if (!document_url || !document_url_back || !selfie_url) {
    return res.status(400).json({
      status: false,
      message: 'Front ID, Back ID and a Selfie are all required'
    });
  }

  try {
    // 2) Prevent multiple simultaneous submissions
    const [[pending]] = await pool.query(
      `SELECT id 
       FROM kyc_verificationss 
       WHERE user_id = ? AND status = 'pending' 
       LIMIT 1`,
      [userId]
    );

    if (pending) {
      return res.status(400).json({
        status: false,
        message: 'You already have a pending KYC. Please wait for review.'
      });
    }

    // 3) Insert new KYC record
    const [insertResult] = await pool.query(
      `INSERT INTO kyc_verificationss
       (user_id, document_type, document_number, document_url, document_url_back, selfie_url, status, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'pending', NOW(), NOW())`,
      [userId, document_type, document_url, document_url_back, selfie_url]
    );

    const kycId = insertResult.insertId;
    console.log('KYC INSERTED ID:', kycId);

    // 4) Audit log (non-blocking)
    await safeAuditLog(
      null,              // adminId (null because this is user action)
      userId,            // userId
      'KYC_SUBMITTED',   // action
      'kyc',             // entity
      kycId,             // entityId
      { document_type }  // details
    );

    // 5) Notify user (non-blocking)
const [[user]] = await pool.query(
  'SELECT email FROM users WHERE id = ? LIMIT 1',
  [userId]
);

await safeNotify({
  userId,
  email: user?.email,
  title: 'KYC Submitted',
  message: 'Your KYC documents have been submitted successfully and are currently under review. You will be notified once a decision is made.',
  type: 'security',
  severity: 'info',
  metadata: {
    kyc_id: kycId,
    document_type
  }
});



    return res.status(201).json({
      status: true,
      message: 'KYC submitted successfully',
      kyc_id: kycId
    });
  } catch (err) {
    console.error('submitKyc err:', err);
    return res.status(500).json({
      status: false,
      message: 'Server error',
      error: err.message
    });
  }
};

/**
 * GET /api/kyc/status
 * Returns latest 10 KYC records for the logged-in user
 *
 * NOTE: returns an ARRAY directly, because your frontend
 * currently does: Array.isArray(res.data)
 */
exports.getKycStatus = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res
      .status(401)
      .json({ status: false, message: 'Unauthorized' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT 
         id,
         document_type,
         document_url,
         document_url_back,
         selfie_url,
         status,
         rejection_reason,
         created_at,
         approved_at
       FROM kyc_verificationss
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId]
    );

    // Frontend expects array directly
    return res.json(rows);
  } catch (err) {
    console.error('getKycStatus err:', err);
    return res.status(500).json({
      status: false,
      message: 'Server error',
      error: err.message
    });
  }
};
