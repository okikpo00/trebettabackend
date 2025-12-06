// controllers/adminKycController.js
const pool = require('../config/db');
const { auditLog } = require('../utils/auditLog');
const notify = require('../utils/notify');

/**
 * Safe wrappers so audit/notify never crash admin actions
 */
async function safeAuditLog(adminId, userId, action, entity, entityId, details) {
  try {
    await auditLog(adminId, userId, action, entity, entityId, details);
  } catch (err) {
    console.warn('admin auditLog failed (ignored):', err.message);
  }
}

async function safeNotify(payload) {
  try {
    await notify(payload);
  } catch (err) {
    console.warn('admin notify failed (ignored):', err.message);
  }
}

/**
 * GET /api/admin/kyc/pending
 * List all pending KYC records for review
 */
exports.listPending = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT 
         kv.*,
         u.username,
         u.email,
         u.first_name,
         u.last_name
       FROM kyc_verificationss kv
       LEFT JOIN users u ON u.id = kv.user_id
       WHERE kv.status = 'pending'
       ORDER BY kv.created_at DESC`
    );

    return res.json({ status: true, data: rows });
  } catch (err) {
    console.error('admin listPending err', err);
    return res.status(500).json({
      status: false,
      message: 'Server error',
      error: err.message
    });
  }
};

/**
 * POST /api/admin/kyc/approve/:id
 */
exports.approveKyc = async (req, res) => {
  const adminId = req.user?.id;
  const kycId = req.params.id;

  if (!adminId) {
    return res
      .status(401)
      .json({ status: false, message: 'Unauthorized admin' });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1) Lock record
    const [[rec]] = await conn.query(
      `SELECT * FROM kyc_verificationss WHERE id = ? FOR UPDATE`,
      [kycId]
    );

    if (!rec) {
      await conn.rollback();
      return res
        .status(404)
        .json({ status: false, message: 'KYC record not found' });
    }

    if (rec.status === 'approved') {
      await conn.rollback();
      return res
        .status(400)
        .json({ status: false, message: 'Already approved' });
    }

    // 2) Approve record
    await conn.query(
      `UPDATE kyc_verificationss 
       SET status = 'approved',
           approved_by = ?,
           approved_at = NOW(),
           updated_at = NOW()
       WHERE id = ?`,
      [adminId, kycId]
    );

    // 3) (Optional) upgrade user tier if you have kyc_tier column
    try {
      await conn.query(
        `UPDATE users SET kyc_tier = 'verified' WHERE id = ?`,
        [rec.user_id]
      );
    } catch (tierErr) {
      console.warn('Warning: kyc_tier update failed (ignored):', tierErr.message);
    }

    await conn.commit();
    conn.release();
    conn = null;

    // 4) Audit log (non-blocking)
    await safeAuditLog(
      adminId,          // admin performing the action
      rec.user_id,      // affected user
      'KYC_APPROVED',   // action
      'kyc',            // entity
      kycId,            // entityId
      {}                // details
    );

    // 5) Notify user (non-blocking)
    await safeNotify({
      userId: rec.user_id,
      title: 'KYC approved',
      message: 'Your KYC has been approved. You now have full access.'
    });

    return res.json({ status: true, message: 'KYC approved' });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); conn.release(); } catch (e) {}
    }
    console.error('approveKyc err', err);
    return res.status(500).json({
      status: false,
      message: 'Server error',
      error: err.message
    });
  }
};

/**
 * POST /api/admin/kyc/reject/:id
 * Body: { reason?: string }
 */
exports.rejectKyc = async (req, res) => {
  const adminId = req.user?.id;
  const kycId = req.params.id;
  const { reason } = req.body || {};

  if (!adminId) {
    return res
      .status(401)
      .json({ status: false, message: 'Unauthorized admin' });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[rec]] = await conn.query(
      `SELECT * FROM kyc_verificationss WHERE id = ? FOR UPDATE`,
      [kycId]
    );

    if (!rec) {
      await conn.rollback();
      return res
        .status(404)
        .json({ status: false, message: 'KYC record not found' });
    }

    if (rec.status === 'rejected') {
      await conn.rollback();
      return res
        .status(400)
        .json({ status: false, message: 'Already rejected' });
    }

    const finalReason = reason || 'Invalid or unclear documents';

    await conn.query(
      `UPDATE kyc_verificationss 
       SET status = 'rejected',
           rejection_reason = ?,
           approved_by = ?,
           approved_at = NOW(),
           updated_at = NOW()
       WHERE id = ?`,
      [finalReason, adminId, kycId]
    );

    await conn.commit();
    conn.release();
    conn = null;

    // Audit log (non-blocking)
    await safeAuditLog(
      adminId,
      rec.user_id,
      'KYC_REJECTED',
      'kyc',
      kycId,
      { reason: finalReason }
    );

    // Notify user (non-blocking)
    await safeNotify({
      userId: rec.user_id,
      title: 'KYC rejected',
      message: 'Your KYC was rejected. Please resubmit valid documents.',
    });

    return res.json({ status: true, message: 'KYC rejected' });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); conn.release(); } catch (e) {}
    }
    console.error('rejectKyc err', err);
    return res.status(500).json({
      status: false,
      message: 'Server error',
      error: err.message
    });
  }
};
