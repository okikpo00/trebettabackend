// services/dashboardService.js
const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * Small helper: convert MySQL rows into date/value pairs for charts
 */
function mapDateSeries(rows, valueKey = 'total') {
  return rows.map(r => ({
    date: r.d || r.date,
    value: Number(r[valueKey] || 0)
  }));
}

/**
 * -------------------------------------------------------
 * OVERVIEW  (CEO CARDS + CHART DATA)
 * -------------------------------------------------------
 */
async function getOverview() {
  console.log('[dashboardService.getOverview] start');
  try {
    // --- USERS ---
    const [userRows] = await pool.query(`
      SELECT 
        COUNT(*) AS total_users,
        SUM(CASE WHEN created_at >= NOW() - INTERVAL 24 HOUR THEN 1 ELSE 0 END) AS new_users_24h
      FROM users
    `);
    const userStats = userRows[0] || { total_users: 0, new_users_24h: 0 };
    console.log('[dashboardService.getOverview] userStats:', userStats);

    // --- WALLETS ---
    const [walletAggRows] = await pool.query(`
      SELECT 
        COALESCE(SUM(balance),0) AS total_wallet_balance,
        COALESCE(AVG(balance),0) AS avg_wallet_balance
      FROM wallets
    `);
    const walletAgg = walletAggRows[0] || {};
    console.log('[dashboardService.getOverview] walletAgg:', walletAgg);

    // --- TRANSACTIONS ---
    const [txAggRows] = await pool.query(`
      SELECT
        SUM(CASE WHEN type='deposit'    AND status='completed' THEN amount ELSE 0 END) AS total_deposits,
        SUM(CASE WHEN type='withdrawal' AND status='completed' THEN amount ELSE 0 END) AS total_withdrawals
      FROM transactions
    `);
    const txAgg = txAggRows[0] || {};
    console.log('[dashboardService.getOverview] txAgg:', txAgg);

    // --- ACTIVE POOLS ---
    const [activePoolsRows] = await pool.query(`
      SELECT 
        SUM(CASE WHEN status='open' OR status='locked' THEN 1 ELSE 0 END) AS active_pools
      FROM pools
    `);
    const activePools = activePoolsRows[0]?.active_pools || 0;

    const [poolsCountsRows] = await pool.query(`
      SELECT status, COUNT(*) AS cnt
      FROM pools
      GROUP BY status
    `);
    const poolsByStatus = {};
    (poolsCountsRows || []).forEach(r => {
      poolsByStatus[r.status] = r.cnt;
    });
    console.log('[dashboardService.getOverview] poolsByStatus:', poolsByStatus);

    // --- KYC SUMMARY ---
    const [kycRows] = await pool.query(`
      SELECT 
        SUM(CASE WHEN kyc_status='pending'  THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN kyc_status='approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN kyc_status='rejected' THEN 1 ELSE 0 END) AS rejected
      FROM users
    `);
    const kyc = kycRows[0] || { pending: 0, approved: 0, rejected: 0 };

    // --- COMPANY CUT ---
    const [cutRows] = await pool.query(`
      SELECT 
        COALESCE(SUM(total_stake * (company_cut_percent / 100)), 0) AS total_company_cut,
        COALESCE(SUM(
          CASE 
            WHEN created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) 
              THEN total_stake * (company_cut_percent / 100)
            ELSE 0 
          END
        ), 0) AS company_cut_last_30
      FROM pools
      WHERE status IN ('settled','rollover','refunded')
    `);
    const companyCut = {
      total: Number(cutRows[0]?.total_company_cut || 0),
      last30Days: Number(cutRows[0]?.company_cut_last_30 || 0)
    };
    console.log('[dashboardService.getOverview] companyCut:', companyCut);

    // --- ROLLOVER ---
    const [rollBalRows] = await pool.query(`
      SELECT COALESCE(amount,0) AS amount 
      FROM rollover_pool_balance 
      WHERE id = 1
    `);
    const rolloverBalance = Number(rollBalRows[0]?.amount || 0);

    const [rollHistRows] = await pool.query(`
      SELECT COALESCE(SUM(amount),0) AS total_applied
      FROM rollover_history
    `);
    const rollover = {
      current_balance: rolloverBalance,
      total_applied: Number(rollHistRows[0]?.total_applied || 0)
    };
    console.log('[dashboardService.getOverview] rollover:', rollover);

    // --- WITHDRAWALS ---
    const [wdRows] = await pool.query(`
      SELECT 
        COUNT(*) AS pending_count,
        COALESCE(SUM(amount),0) AS pending_amount
      FROM withdrawal_requests
      WHERE status IN ('pending','pending_approval','processing')
    `);
    const withdrawals = {
      pending_count: wdRows[0]?.pending_count || 0,
      pending_amount: Number(wdRows[0]?.pending_amount || 0)
    };
    console.log('[dashboardService.getOverview] withdrawals:', withdrawals);

    // --- CHARTS (7 DAYS) ---
    const [depositTrendRows] = await pool.query(`
      SELECT DATE(created_at) AS d, COALESCE(SUM(amount),0) AS total
      FROM transactions
      WHERE type='deposit'
        AND status='completed'
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `);

    const [withdrawTrendRows] = await pool.query(`
      SELECT DATE(created_at) AS d, COALESCE(SUM(amount),0) AS total
      FROM transactions
      WHERE type='withdrawal'
        AND status='completed'
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `);

    const [newUsersTrendRows] = await pool.query(`
      SELECT DATE(created_at) AS d, COUNT(*) AS total
      FROM users
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `);

    const [poolsTrendRows] = await pool.query(`
      SELECT DATE(created_at) AS d, COUNT(*) AS total
      FROM pools
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `);

    const charts = {
      deposits7d: mapDateSeries(depositTrendRows),
      withdrawals7d: mapDateSeries(withdrawTrendRows),
      newUsers7d: mapDateSeries(newUsersTrendRows),
      pools7d: mapDateSeries(poolsTrendRows)
    };

    console.log('[dashboardService.getOverview] charts sample:', {
      depositsLen: charts.deposits7d.length,
      withdrawalsLen: charts.withdrawals7d.length
    });

    // --- OLD COMPATIBILITY FIELDS ---
    const totalUsers = userStats.total_users || 0;
    const totalWalletBalance = Number(walletAgg.total_wallet_balance || 0);
    const totalDeposits = Number(txAgg.total_deposits || 0);
    const totalWithdrawals = Number(txAgg.total_withdrawals || 0);

    const overview = {
      totalUsers,
      totalWalletBalance,
      totalDeposits,
      totalWithdrawals,
      activePools,
      poolsByStatus,
      kyc,
      avgWalletBalance: Number(walletAgg.avg_wallet_balance || 0),
      newUsers24h: userStats.new_users_24h || 0,
      companyCut,
      rollover,
      withdrawals,
      charts
    };

    console.log('[dashboardService.getOverview] done', {
      totalUsers,
      totalDeposits,
      totalWithdrawals,
      activePools
    });

    return overview;
  } catch (err) {
    console.error('[dashboardService.getOverview] ERROR:', err);
    logger.error('dashboardService.getOverview error', err);
    throw err;
  }
}

/**
 * -------------------------------------------------------
 * WALLET ANALYTICS
 * -------------------------------------------------------
 */
async function getWalletsSummary() {
  console.log('[dashboardService.getWalletsSummary] start');
  try {
    const [[totals]] = await pool.query(`
      SELECT 
        COALESCE(SUM(balance),0) AS total_balance,
        COALESCE(AVG(balance),0) AS avg_balance
      FROM wallets
    `);

    const [topRows] = await pool.query(`
      SELECT 
        w.user_id, w.balance, u.username, u.email
      FROM wallets w 
      JOIN users u ON u.id = w.user_id
      ORDER BY w.balance DESC
      LIMIT 10
    `);

    const [[pendingRow]] = await pool.query(`
      SELECT COALESCE(SUM(amount),0) AS pending_withdrawals 
      FROM transactions 
      WHERE type='withdrawal' AND status IN ('pending','processing')
    `);

    const [[frozenRow]] = await pool.query(`
      SELECT COUNT(*) AS frozen_wallets
      FROM wallets
      WHERE status = 'frozen'
    `);

    const [bucketRows] = await pool.query(`
      SELECT
        SUM(CASE WHEN balance < 1000 THEN 1 ELSE 0 END) AS below_1k,
        SUM(CASE WHEN balance BETWEEN 1000 AND 9999 THEN 1 ELSE 0 END) AS between_1k_10k,
        SUM(CASE WHEN balance BETWEEN 10000 AND 99999 THEN 1 ELSE 0 END) AS between_10k_100k,
        SUM(CASE WHEN balance >= 100000 THEN 1 ELSE 0 END) AS above_100k
      FROM wallets
    `);
    const buckets = bucketRows[0] || {};

    const result = {
      total_balance: Number(totals.total_balance || 0),
      avg_balance: Number(totals.avg_balance || 0),
      top_wallets: topRows,
      pending_withdrawals: Number(pendingRow.pending_withdrawals || 0),
      frozen_wallets: frozenRow.frozen_wallets || 0,
      balance_buckets: {
        below_1k: buckets.below_1k || 0,
        between_1k_10k: buckets.between_1k_10k || 0,
        between_10k_100k: buckets.between_10k_100k || 0,
        above_100k: buckets.above_100k || 0
      }
    };

    console.log('[dashboardService.getWalletsSummary] done', {
      total_balance: result.total_balance,
      avg_balance: result.avg_balance
    });

    return result;
  } catch (err) {
    console.error('[dashboardService.getWalletsSummary] ERROR:', err);
    logger.error('dashboardService.getWalletsSummary error', err);
    throw err;
  }
}

/**
 * -------------------------------------------------------
 * POOL ANALYTICS (paginated)
 * -------------------------------------------------------
 */
async function getPoolsSummary({ page = 1, limit = 20 } = {}) {
  console.log('[dashboardService.getPoolsSummary] start', { page, limit });
  try {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Number(limit) || 20);
    const offset = (safePage - 1) * safeLimit;

    const [[countRow]] = await pool.query('SELECT COUNT(*) AS total FROM pools');
    const totalPools = countRow.total || 0;

    const [rows] = await pool.query(`
      SELECT 
        p.id, p.title, p.type, p.status, 
        COALESCE(p.total_pool_amount,0) AS total_pool_amount,
        COALESCE(p.total_stake,0) AS total_stake,
        p.company_cut_percent,
        IFNULL(s.participant_count,0) AS participant_count, 
        p.created_at,
        p.closing_date
      FROM pools p
      LEFT JOIN pool_participants_summary s ON s.pool_id = p.id
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `, [safeLimit, offset]);

    const pools = rows.map(r => {
      const participants = Number(r.participant_count || 0);
      const totalStake = Number(r.total_stake || r.total_pool_amount || 0);
      const avg_bet = participants > 0 ? totalStake / participants : 0;
      const cutPct = Number(r.company_cut_percent || 0);
      const company_cut_amount = totalStake * (cutPct / 100);

      return {
        id: r.id,
        title: r.title,
        type: r.type,
        status: r.status,
        total_pool_amount: Number(r.total_pool_amount || 0),
        total_stake: totalStake,
        participant_count: participants,
        created_at: r.created_at,
        closing_date: r.closing_date,
        avg_bet: Number(avg_bet.toFixed(2)),
        company_cut_amount: Number(company_cut_amount.toFixed(2))
      };
    });

    const result = { totalPools, page: safePage, limit: safeLimit, pools };

    console.log('[dashboardService.getPoolsSummary] done', {
      totalPools,
      page: safePage,
      returned: pools.length
    });

    return result;
  } catch (err) {
    console.error('[dashboardService.getPoolsSummary] ERROR:', err);
    logger.error('dashboardService.getPoolsSummary error', err);
    throw err;
  }
}

/**
 * -------------------------------------------------------
 * ACTIVITY FEED (users + admin actions)
 * -------------------------------------------------------
 */
async function getActivityFeed({ page = 1, limit = 50, type = null } = {}) {
  console.log('[dashboardService.getActivityFeed] start', { page, limit, type });
  try {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(200, Number(limit) || 50);
    const offset = (safePage - 1) * safeLimit;
    const params = [];

    let typeFilter = '';
    if (type) {
      typeFilter = 'WHERE t.type = ?';
      params.push(type);
    }

    const sql = `
      SELECT 
        'transaction' AS kind, 
        t.id, 
        t.user_id, 
        u.username AS user_name,
        t.type AS event_type, 
        t.amount, 
        t.reference, 
        t.status,
        t.created_at
      FROM transactions t
      LEFT JOIN users u ON u.id = t.user_id
      ${typeFilter}
      
      UNION ALL
      
      SELECT 
        'admin' AS kind, 
        a.id, 
        a.user_id, 
        u2.username AS user_name,
        a.action AS event_type, 
        NULL AS amount, 
        NULL AS reference, 
        NULL AS status,
        a.created_at
      FROM audit_log a
      LEFT JOIN users u2 ON u2.id = a.user_id
      
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    params.push(safeLimit, offset);
    const [rows] = await pool.query(sql, params);

    console.log('[dashboardService.getActivityFeed] done', {
      page: safePage,
      limit: safeLimit,
      returned: rows.length
    });

    return { page: safePage, limit: safeLimit, data: rows };
  } catch (err) {
    console.error('[dashboardService.getActivityFeed] ERROR:', err);
    logger.error('dashboardService.getActivityFeed error', err);
    throw err;
  }
}

module.exports = {
  getOverview,
  getWalletsSummary,
  getPoolsSummary,
  getActivityFeed
};
