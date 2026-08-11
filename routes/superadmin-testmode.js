// routes/superadmin-testmode.js
// Lets a superadmin flip global test mode on/off. Restaurant admins have
// no route and no UI for this — it does not exist in the admin backend
// at all, so they can't see or touch it.
//
// Mounted in server.js as: app.use("/api/superadmin/test-mode", superadminTestModeRoutes);

const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateSuperadmin } = require("./superadmin");

router.use(authenticateSuperadmin);

router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT enabled, updated_at FROM test_mode_settings WHERE id = 1"
    );
    res.json({
      success: true,
      enabled: rows.length ? !!rows[0].enabled : false,
      updatedAt: rows.length ? rows[0].updated_at : null,
    });
  } catch (err) {
    console.error("Get Test Mode (superadmin) Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch test mode status" });
  }
});

router.put("/", async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ success: false, message: "enabled must be true or false" });
    }

    await pool.query(
      `INSERT INTO test_mode_settings (id, enabled) VALUES (1, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
      [enabled ? 1 : 0]
    );

    const io = req.app.get("io");
    if (io) io.emit("test-mode-updated", { enabled });

    res.json({ success: true, enabled });
  } catch (err) {
    console.error("Update Test Mode (superadmin) Error:", err);
    res.status(500).json({ success: false, message: "Failed to update test mode" });
  }
});

module.exports = router;