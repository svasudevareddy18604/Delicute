// routes/tables.js
// Table management routes — admin CRUD + public "scan" endpoint used
// when a customer scans a table's QR code, + public "active" listing
// used by the customer-facing table-select popup.
//
// NOTE: adjust these two require paths to match your project —
// use the SAME db pool and admin-auth middleware your other admin
// route files (orders.js, menu.js, coupons.js) already import.
const express = require("express");
const router = express.Router();
const pool = require("../db");                     // mysql2 promise pool
const verifyAdminToken = require("../middleware/authenticate");

/* =========================================================
   Ensure the qr_settings table exists. This is a small,
   self-contained table just for the "ordering page base URL"
   used to build every table's QR code — it does NOT touch or
   assume anything about any other `settings` table you may
   already have for cafe-wide config (GST %, dine-in/out toggles,
   etc). Runs once when this router is first loaded.
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
    console.error("Failed to ensure qr_settings table exists:", err);
  }
})();

/* =========================================================
   PUBLIC ROUTES — no auth, used by the customer-facing site
   These must be declared BEFORE "GET /:id" below. Express
   matches routes top-to-bottom, and "/:id" matches ANY single
   path segment — including the literal word "active" — so if
   "/:id" comes first it swallows this request and runs it
   through verifyAdminToken, which is exactly what was causing
   your 401s.
   ========================================================= */

// GET /api/tables/active  -> list active tables (customer table-picker)
router.get("/active", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, table_number, capacity, location
       FROM tables
       WHERE status = 'active'
       ORDER BY CAST(table_number AS UNSIGNED), table_number`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Get Active Tables Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch active tables" });
  }
});

// GET /api/tables/scan/:number  -> single table lookup when a QR is scanned
// (kept here, before "/:id", purely for readability — it doesn't actually
// collide with "/:id" since it has two path segments, not one)
router.get("/scan/:number", async (req, res) => {
  try {
    const { number } = req.params;

    const [rows] = await pool.query(
      "SELECT id, table_number, capacity, location, status FROM tables WHERE table_number = ?",
      [number]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "This table code isn't recognized. Please ask staff for help.",
      });
    }

    const table = rows[0];

    if (table.status !== "active") {
      return res.status(403).json({
        success: false,
        message: `Table ${table.table_number} is currently inactive. Please ask staff for assistance.`,
      });
    }

    res.json({
      success: true,
      table: {
        id: table.id,
        number: table.table_number,
        capacity: table.capacity,
        location: table.location,
      },
    });
  } catch (err) {
    console.error("Scan Table Error:", err);
    res.status(500).json({
      success: false,
      message: "Something went wrong. Please ask staff for help.",
    });
  }
});

/* =========================================================
   ADMIN ROUTES — protected, used by admintablemanage.html
   ========================================================= */

// GET /api/tables  -> list all tables
router.get("/", verifyAdminToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, table_number, capacity, location, status, created_at, updated_at
       FROM tables
       ORDER BY CAST(table_number AS UNSIGNED), table_number`
    );
    res.json({ success: true, tables: rows });
  } catch (err) {
    console.error("Get Tables Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch tables" });
  }
});

// GET /api/tables/qr-settings  -> the ordering-page base URL used to build every table's QR
// This is the setting from the "Ordering Page URL" box at the top of the Tables admin page.
// NOTE: must stay above "GET /:id" below, for the same reason "/active" does — otherwise
// "/:id" would swallow the literal word "qr-settings" as if it were an :id value.
router.get("/qr-settings", verifyAdminToken, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT base_url FROM qr_settings WHERE id = 1");
    res.json({
      success: true,
      settings: { base_url: rows.length ? rows[0].base_url : null },
    });
  } catch (err) {
    console.error("Get QR Settings Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch QR settings" });
  }
});

// PUT /api/tables/qr-settings  -> save the ordering-page base URL
// Upserts a single row (id = 1). Whatever you save here is what every
// table's QR is built from, from then on, on every device — until you
// change it again.
router.put("/qr-settings", verifyAdminToken, async (req, res) => {
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
    console.error("Update QR Settings Error:", err);
    res.status(500).json({ success: false, message: "Failed to save QR settings" });
  }
});

// GET /api/tables/:id  -> single table
// NOTE: this MUST stay below "/active", "/scan/:number", and "/qr-settings"
// above, otherwise it will intercept those requests.
router.get("/:id", verifyAdminToken, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM tables WHERE id = ?", [req.params.id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Table not found" });
    }
    res.json({ success: true, table: rows[0] });
  } catch (err) {
    console.error("Get Table Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch table" });
  }
});

// POST /api/tables  -> create table (table_number required, everything else optional)
router.post("/", verifyAdminToken, async (req, res) => {
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
    console.error("Create Table Error:", err);
    res.status(500).json({ success: false, message: "Failed to create table" });
  }
});

// PUT /api/tables/:id  -> update table
router.put("/:id", verifyAdminToken, async (req, res) => {
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
    console.error("Update Table Error:", err);
    res.status(500).json({ success: false, message: "Failed to update table" });
  }
});

// DELETE /api/tables/:id
router.delete("/:id", verifyAdminToken, async (req, res) => {
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
    console.error("Delete Table Error:", err);
    res.status(500).json({ success: false, message: "Failed to delete table" });
  }
});

module.exports = router;