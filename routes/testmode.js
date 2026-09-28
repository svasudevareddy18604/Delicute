// routes/testmode.js
// PUBLIC read-only endpoint — tells the customer-facing site whether
// test mode is currently on. No auth required (customers hit this).
// Actual toggling only happens via routes/superadmin-testmode.js.

const express = require("express");
const router = express.Router();
const pool = require("../db");

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_mode_settings (
        id INT PRIMARY KEY DEFAULT 1,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    // seed row so GET never has to special-case "no row yet"
    await pool.query(
      `INSERT IGNORE INTO test_mode_settings (id, enabled) VALUES (1, 0)`
    );
  } catch (err) {
    console.error("Failed to ensure test_mode_settings table exists:", err);
  }
})();

router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT enabled FROM test_mode_settings WHERE id = 1"
    );
    res.json({ success: true, enabled: rows.length ? !!rows[0].enabled : false });
  } catch (err) {
    console.error("Get Test Mode Status Error:", err);
    // fail safe: if we can't confirm, report OFF so real customer orders
    // never accidentally get silently swallowed as test orders
    res.json({ success: true, enabled: false });
  }
});

module.exports = router;