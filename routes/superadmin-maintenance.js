const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateSuperadmin } = require("./superadmin");

// GET is public — your customer-facing frontend and other middleware
// will also need to read this to decide whether to show the maintenance screen.
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT maintenance_enabled, maintenance_message FROM site_config WHERE id = 1"
    );
    if (rows.length === 0) {
      return res.json({ success: true, enabled: false, message: "" });
    }
    res.json({
      success: true,
      enabled: !!rows[0].maintenance_enabled,
      message: rows[0].maintenance_message || "",
    });
  } catch (err) {
    console.error("Maintenance fetch error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch maintenance status" });
  }
});

// PUT is protected — only a logged-in superadmin can flip the switch.
router.put("/", authenticateSuperadmin, async (req, res) => {
  const { enabled, message } = req.body;
  try {
    await pool.query(
      `UPDATE site_config SET maintenance_enabled = ?, maintenance_message = ? WHERE id = 1`,
      [enabled ? 1 : 0, message || null]
    );
    res.json({ success: true, message: "Maintenance status updated" });
  } catch (err) {
    console.error("Maintenance update error:", err);
    res.status(500).json({ success: false, message: "Failed to update maintenance status" });
  }
});

module.exports = router;