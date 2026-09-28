// routes/superadmin-tables.js
// Table management for the superadmin console — mirrors routes/tables.js
// admin CRUD, but protected by authenticateSuperadmin (separate auth
// system, separate cookie) instead of the restaurant-admin token.
//
// Mounted in server.js as: app.use("/api/superadmin/tables", superadminTablesRoutes);

const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateSuperadmin } = require("./superadmin");

// Every route below requires a valid superadmin session.
router.use(authenticateSuperadmin);

/* =========================================================
   Ensure qr_settings table exists (same table routes/tables.js
   uses — shared, since it's one base_url for the whole ordering
   flow regardless of which panel edits it).
   ========================================================= */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS qr_settings (
        id INT PRIMARY KEY DEFAULT 1,
        base_url VARCHAR(500) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  } catch (err) {
    console.error("Failed to ensure qr_settings table exists (superadmin):", err);
  }
})();

// ================== QR SETTINGS ==================
// Must stay above "/:id" for the same reason as in tables.js —
// otherwise "/:id" would swallow "qr-settings" as an id value.

router.get("/qr-settings", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT base_url FROM qr_settings WHERE id = 1");
    res.json({
      success: true,
      settings: { base_url: rows.length ? rows[0].base_url : null },
    });
  } catch (err) {
    console.error("Get QR Settings Error (superadmin):", err);
    res.status(500).json({ success: false, message: "Failed to fetch QR settings" });
  }
});

router.put("/qr-settings", async (req, res) => {
  try {
    const { base_url } = req.body;
    if (!base_url || !base_url.trim()) {
      return res.status(400).json({ success: false, message: "base_url is required" });
    }
    const trimmed = base_url.trim();

    await pool.query(
      `INSERT INTO qr_settings (id, base_url) VALUES (1, ?)
       ON DUPLICATE KEY UPDATE base_url = VALUES(base_url)`,
      [trimmed]
    );

    const io = req.app.get("io");
    if (io) io.emit("qr-settings-updated", { base_url: trimmed });

    res.json({ success: true, settings: { base_url: trimmed } });
  } catch (err) {
    console.error("Update QR Settings Error (superadmin):", err);
    res.status(500).json({ success: false, message: "Failed to save QR settings" });
  }
});

// ================== LIST ALL TABLES ==================
router.get("/", async (req, res) => {
  try {
    const { q, status } = req.query;
    const where = [];
    const params = [];

    if (status === "active" || status === "inactive") {
      where.push("status = ?");
      params.push(status);
    }
    if (q && q.trim()) {
      where.push("(table_number LIKE ? OR location LIKE ?)");
      params.push(`%${q.trim()}%`, `%${q.trim()}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT id, table_number, capacity, location, status, created_at, updated_at
       FROM tables ${whereSql}
       ORDER BY CAST(table_number AS UNSIGNED), table_number`,
      params
    );
    res.json({ success: true, tables: rows });
  } catch (err) {
    console.error("Get Tables Error (superadmin):", err);
    res.status(500).json({ success: false, message: "Failed to fetch tables" });
  }
});

// ================== SINGLE TABLE ==================
router.get("/:id", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM tables WHERE id = ?", [req.params.id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Table not found" });
    }
    res.json({ success: true, table: rows[0] });
  } catch (err) {
    console.error("Get Table Error (superadmin):", err);
    res.status(500).json({ success: false, message: "Failed to fetch table" });
  }
});

// ================== CREATE TABLE ==================
router.post("/", async (req, res) => {
  try {
    const { table_number, capacity, location, status } = req.body;

    if (!table_number || !table_number.trim()) {
      return res.status(400).json({ success: false, message: "Table number is required" });
    }

    const [existing] = await pool.query(
      "SELECT id FROM tables WHERE table_number = ?",
      [table_number.trim()]
    );
    if (existing.length) {
      return res.status(409).json({ success: false, message: "A table with this number already exists" });
    }

    const [result] = await pool.query(
      "INSERT INTO tables (table_number, capacity, location, status) VALUES (?, ?, ?, ?)",
      [
        table_number.trim(),
        capacity || null,
        location || null,
        status === "inactive" ? "inactive" : "active",
      ]
    );

    const [rows] = await pool.query("SELECT * FROM tables WHERE id = ?", [result.insertId]);

    const io = req.app.get("io");
    if (io) io.emit("table-created", rows[0]);

    res.status(201).json({ success: true, table: rows[0] });
  } catch (err) {
    console.error("Create Table Error (superadmin):", err);
    res.status(500).json({ success: false, message: "Failed to create table" });
  }
});

// ================== UPDATE TABLE ==================
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { table_number, capacity, location, status } = req.body;

    const [existing] = await pool.query("SELECT id FROM tables WHERE id = ?", [id]);
    if (!existing.length) {
      return res.status(404).json({ success: false, message: "Table not found" });
    }

    if (!table_number || !table_number.trim()) {
      return res.status(400).json({ success: false, message: "Table number is required" });
    }

    const [dup] = await pool.query(
      "SELECT id FROM tables WHERE table_number = ? AND id != ?",
      [table_number.trim(), id]
    );
    if (dup.length) {
      return res.status(409).json({ success: false, message: "A table with this number already exists" });
    }

    await pool.query(
      "UPDATE tables SET table_number = ?, capacity = ?, location = ?, status = ? WHERE id = ?",
      [
        table_number.trim(),
        capacity || null,
        location || null,
        status === "inactive" ? "inactive" : "active",
        id,
      ]
    );

    const [rows] = await pool.query("SELECT * FROM tables WHERE id = ?", [id]);

    const io = req.app.get("io");
    if (io) io.emit("table-updated", rows[0]);

    res.json({ success: true, table: rows[0] });
  } catch (err) {
    console.error("Update Table Error (superadmin):", err);
    res.status(500).json({ success: false, message: "Failed to update table" });
  }
});

// ================== TOGGLE STATUS ==================
router.put("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (status !== "active" && status !== "inactive") {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const [result] = await pool.query("UPDATE tables SET status = ? WHERE id = ?", [status, id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Table not found" });
    }

    const [rows] = await pool.query("SELECT * FROM tables WHERE id = ?", [id]);

    const io = req.app.get("io");
    if (io) io.emit("table-updated", rows[0]);

    res.json({ success: true, table: rows[0] });
  } catch (err) {
    console.error("Toggle Table Status Error (superadmin):", err);
    res.status(500).json({ success: false, message: "Failed to update table status" });
  }
});

// ================== DELETE TABLE ==================
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [existing] = await pool.query("SELECT * FROM tables WHERE id = ?", [id]);
    if (!existing.length) {
      return res.status(404).json({ success: false, message: "Table not found" });
    }

    await pool.query("DELETE FROM tables WHERE id = ?", [id]);

    const io = req.app.get("io");
    if (io) io.emit("table-deleted", { id: Number(id) });

    res.json({ success: true, message: "Table deleted" });
  } catch (err) {
    console.error("Delete Table Error (superadmin):", err);
    res.status(500).json({ success: false, message: "Failed to delete table" });
  }
});

module.exports = router;