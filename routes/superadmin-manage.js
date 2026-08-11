// ================== SUPERADMIN — MANAGE ADMINS & SUPERADMINS ==================
// Handles CRUD for:
//   - Restaurant admins  -> "users" table where role = 'admin'
//   - Super admins       -> "superadmins" table
//   - Login logs         -> "superadmin_login_logs" table
//
// All routes here are protected — only a logged-in superadmin can hit them.
// Mounted in server.js as: app.use("/api/superadmin", superadminManageRoutes);

const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");     // matches routes/auth.js (users table)
const bcryptjs = require("bcryptjs"); // matches routes/superadmin.js (superadmins table)
const pool = require("../db");
const { authenticateSuperadmin } = require("./superadmin");

// Every route below requires a valid superadmin session.
router.use(authenticateSuperadmin);

/* ============================================================
   RESTAURANT ADMINS  (users table, role = 'admin')
   ============================================================ */

// ---- LIST (with optional search) ----
router.get("/admins", async (req, res) => {
  try {
    const { q } = req.query;
    let sql = `SELECT id, name, email, role, active, created_at
               FROM users WHERE role = 'admin'`;
    const params = [];

    if (q && q.trim()) {
      sql += ` AND (name LIKE ? OR email LIKE ?)`;
      params.push(`%${q.trim()}%`, `%${q.trim()}%`);
    }
    sql += ` ORDER BY id DESC`;

    const [rows] = await pool.query(sql, params);

    const admins = rows.map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      active: r.active === null || r.active === undefined ? true : !!r.active,
      createdAt: r.created_at
    }));

    res.json({ success: true, admins });
  } catch (err) {
    console.error("List admins error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch admins" });
  }
});

// ---- CREATE ----
router.post("/admins", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: "Name, email and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    }

    const cleanEmail = email.trim().toLowerCase();
    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [cleanEmail]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO users (name, email, password, role, active) VALUES (?, ?, ?, 'admin', 1)",
      [name.trim(), cleanEmail, hashedPassword]
    );

    res.status(201).json({ success: true, message: "Admin created successfully" });
  } catch (err) {
    console.error("Create admin error:", err);
    res.status(500).json({ success: false, message: "Failed to create admin" });
  }
});

// ---- TOGGLE ACTIVE / SUSPENDED ----
router.put("/admins/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { active } = req.body;

    const [result] = await pool.query(
      "UPDATE users SET active = ? WHERE id = ? AND role = 'admin'",
      [active ? 1 : 0, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    res.json({ success: true, message: `Admin ${active ? "reactivated" : "suspended"}` });
  } catch (err) {
    console.error("Toggle admin status error:", err);
    res.status(500).json({ success: false, message: "Failed to update admin status" });
  }
});

/* ============================================================
   SUPER ADMINS  (superadmins table)
   ============================================================ */

// ---- LIST (with optional search) ----
router.get("/superadmins", async (req, res) => {
  try {
    const { q } = req.query;
    let sql = `SELECT id, name, email, is_active, otp_enabled, last_login_at
               FROM superadmins`;
    const params = [];

    if (q && q.trim()) {
      sql += ` WHERE (name LIKE ? OR email LIKE ?)`;
      params.push(`%${q.trim()}%`, `%${q.trim()}%`);
    }
    sql += ` ORDER BY id DESC`;

    const [rows] = await pool.query(sql, params);

    const superadmins = rows.map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,
      active: !!r.is_active,
      otpEnabled: !!r.otp_enabled,
      lastLoginAt: r.last_login_at
    }));

    res.json({ success: true, superadmins });
  } catch (err) {
    console.error("List superadmins error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch super admins" });
  }
});

// ---- CREATE ----
router.post("/superadmins", async (req, res) => {
  try {
    const { name, email, password, otpEnabled } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: "Name, email and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    }

    const cleanEmail = email.trim().toLowerCase();
    const [existing] = await pool.query("SELECT id FROM superadmins WHERE email = ?", [cleanEmail]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: "Email already exists" });
    }

    const hashedPassword = await bcryptjs.hash(password, 10);

    await pool.query(
      `INSERT INTO superadmins (name, email, password_hash, is_active, otp_enabled)
       VALUES (?, ?, ?, 1, ?)`,
      [name.trim(), cleanEmail, hashedPassword, otpEnabled ? 1 : 0]
    );

    res.status(201).json({ success: true, message: "Super admin created successfully" });
  } catch (err) {
    console.error("Create superadmin error:", err);
    res.status(500).json({ success: false, message: "Failed to create super admin" });
  }
});

// ---- TOGGLE ACTIVE / SUSPENDED ----
router.put("/superadmins/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { active } = req.body;

    // Prevent a superadmin from suspending their own account
    if (req.superadmin && String(req.superadmin.id) === String(id) && !active) {
      return res.status(400).json({ success: false, message: "You cannot suspend your own account" });
    }

    const [result] = await pool.query(
      "UPDATE superadmins SET is_active = ? WHERE id = ?",
      [active ? 1 : 0, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Super admin not found" });
    }

    res.json({ success: true, message: `Super admin ${active ? "reactivated" : "suspended"}` });
  } catch (err) {
    console.error("Toggle superadmin status error:", err);
    res.status(500).json({ success: false, message: "Failed to update super admin status" });
  }
});

/* ============================================================
   LOGIN LOGS  (superadmin_login_logs table)
   ============================================================ */

// ---- LIST (with optional search + status filter + limit) ----
router.get("/logs", async (req, res) => {
  try {
    const { q = "", success = "", limit = "50" } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);

    let sql = `SELECT id, superadmin_id, email_attempted, ip_address, user_agent, success, reason, created_at
               FROM superadmin_login_logs WHERE 1=1`;
    const params = [];

    if (q.trim()) {
      sql += ` AND (email_attempted LIKE ? OR ip_address LIKE ?)`;
      params.push(`%${q.trim()}%`, `%${q.trim()}%`);
    }

    if (success === "1" || success === "0") {
      sql += ` AND success = ?`;
      params.push(success === "1" ? 1 : 0);
    }

    sql += ` ORDER BY id DESC LIMIT ?`;
    params.push(safeLimit);

    const [rows] = await pool.query(sql, params);

    res.json({ success: true, logs: rows });
  } catch (err) {
    console.error("Fetch superadmin logs error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch login logs" });
  }
});

module.exports = router;