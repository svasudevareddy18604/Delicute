// routes/tables.js
// Table management routes — admin CRUD + public "scan" endpoint used
// when a customer scans a table's QR code.
//
// NOTE: adjust these two require paths to match your project —
// use the SAME db pool and admin-auth middleware your other admin
// route files (orders.js, menu.js, coupons.js) already import.
const express = require("express");
const router = express.Router();
const pool = require("../db");                     // mysql2 promise pool
const verifyAdminToken = require("../middleware/authenticate");

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

// GET /api/tables/:id  -> single table
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

/* =========================================================
   PUBLIC ROUTE — hit the moment a customer scans a table's QR
   QR encodes: https://delicute-kxc9.onrender.com/menu.html?table=5
   menu.html reads ?table=5 and calls GET /api/tables/scan/5
   ========================================================= */

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

module.exports = router;