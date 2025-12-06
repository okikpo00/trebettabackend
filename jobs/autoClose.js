// jobs/autoClose.js
const cron = require("node-cron");
const pool = require("../config/db");

// Runs every 1 minute (you can adjust to every 30s, 5m, hourly, etc.)
cron.schedule("* * * * *", async () => {
  console.log("[AutoClose] Checking for expired bets...");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Find bets that are still OPEN but past close_at
    const [bets] = await conn.query(
      `SELECT id FROM bets 
       WHERE status = 'OPEN' 
       AND closed_at IS NOT NULL 
       AND closed_at <= NOW() 
       FOR UPDATE`
    );

    if (bets.length === 0) {
      await conn.rollback();
      return; // nothing to do
    }

    for (const bet of bets) {
      // Lock the bet
      await conn.query(
        `UPDATE bets 
         SET status = 'LOCKED' 
         WHERE id = ?`,
        [bet.id]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, details)
         VALUES (?, ?, ?, ?, ?)`,
        [
          null, // system job, no user_id
          "AUTO_LOCK",
          "bet",
          bet.id,
          JSON.stringify({ reason: "closed_at reached" }),
        ]
      );
      console.log(`[AutoClose] Bet ${bet.id} locked automatically`);
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error("[AutoClose] Error:", err.message);
  } finally {
    conn.release();
  }
});

cron.schedule("* * * * *", async () => {
  console.log("⏰ AutoClose cron tick at", new Date().toISOString());

  try {
    const [rows] = await pool.query(
      `SELECT * FROM bets WHERE status = 'OPEN' AND closed_at <= NOW()`
    );

    if (rows.length > 0) {
      console.log("Found bets to lock:", rows.map(r => r.id));
    }
  } catch (err) {
    console.error("AutoClose error:", err.message);
  }
});
     