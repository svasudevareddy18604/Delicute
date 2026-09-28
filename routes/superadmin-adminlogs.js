// ================== ADMIN LOGIN LOGS (restaurant admins, not superadmins) ==================
// Mounted in server.js as: app.use("/api/superadmin", superadminAdminLogsRoutes);
// So this file's routes live at /api/superadmin/admin-logs
const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateSuperadmin } = require("./superadmin"); // reuse existing middleware

// GET /api/superadmin/admin-logs?q=&success=&limit=
router.get("/admin-logs", authenticateSuperadmin, async (req, res) => {
  try {
    const { q = "", success = "", limit = "50" } = req.query;

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);

    let sql = `
      SELECT
        l.id, l.admin_id, l.email_attempted, l.ip_address, l.location, l.user_agent,
        l.success, l.reason, l.created_at,
        DATE_FORMAT(l.created_at, '%d %b, %h:%i:%s %p') AS created_at_display,
        u.name AS admin_name
      FROM admin_login_logs l
      LEFT JOIN users u ON u.id = l.admin_id
      WHERE 1=1`;
    const params = [];

    if (q.trim()) {
      sql += ` AND (l.email_attempted LIKE ? OR l.ip_address LIKE ? OR l.location LIKE ?)`;
      params.push(`%${q.trim()}%`, `%${q.trim()}%`, `%${q.trim()}%`);
    }

    if (success === "1" || success === "0") {
      sql += ` AND l.success = ?`;
      params.push(success === "1" ? 1 : 0);
    }

    sql += ` ORDER BY l.id DESC LIMIT ?`;
    params.push(safeLimit);

    const [rows] = await pool.query(sql, params);

    res.json({ success: true, logs: rows });
  } catch (err) {
    console.error("Fetch admin logs error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch admin login logs" });
  }
});

module.exports = router;