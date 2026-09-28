// ================== routes/adminaddon.js ==================
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const db = require("../db"); // your existing MySQL pool/connection module

// ------------------------------------------------
// Auth guard — same cookie-based JWT pattern as /api/auth/check
// ------------------------------------------------
function requireAdmin(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

router.use(requireAdmin);

// ================== GET all groups with nested addons ==================
router.get("/addon-groups", async (req, res) => {
  try {
    const [groups] = await db.query(
      `SELECT id, name, min_selection, max_selection, is_required, created_at
       FROM addon_groups ORDER BY created_at ASC`
    );

    if (!groups.length) return res.json([]);

    const groupIds = groups.map((g) => g.id);
    const [addons] = await db.query(
      `SELECT id, addon_group_id, name, price, is_veg, is_available
       FROM addons
       WHERE addon_group_id IN (?)
       ORDER BY created_at ASC`,
      [groupIds]
    );

    const result = groups.map((g) => ({
      ...g,
      is_required: !!g.is_required,
      addons: addons
        .filter((a) => a.addon_group_id === g.id)
        .map((a) => ({ ...a, is_veg: !!a.is_veg, is_available: !!a.is_available })),
    }));

    res.json(result);
  } catch (err) {
    console.error("GET /addon-groups error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch add-on groups" });
  }
});

// ================== CREATE a group ==================
router.post("/addon-groups", async (req, res) => {
  try {
    const { name, min_selection = 0, max_selection = 1, is_required = false } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Group name is required" });
    }
    if (Number(max_selection) < Number(min_selection)) {
      return res.status(400).json({ success: false, message: "Max selection cannot be less than min" });
    }

    const [result] = await db.query(
      `INSERT INTO addon_groups (name, min_selection, max_selection, is_required)
       VALUES (?, ?, ?, ?)`,
      [name.trim(), min_selection, max_selection, !!is_required]
    );

    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("POST /addon-groups error:", err);
    res.status(500).json({ success: false, message: "Failed to create group" });
  }
});

// ================== UPDATE a group ==================
router.put("/addon-groups/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, min_selection, max_selection, is_required } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Group name is required" });
    }
    if (Number(max_selection) < Number(min_selection)) {
      return res.status(400).json({ success: false, message: "Max selection cannot be less than min" });
    }

    const [result] = await db.query(
      `UPDATE addon_groups
       SET name = ?, min_selection = ?, max_selection = ?, is_required = ?
       WHERE id = ?`,
      [name.trim(), min_selection, max_selection, !!is_required, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("PUT /addon-groups/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to update group" });
  }
});

// ================== DELETE a group (cascades to its addons) ==================
router.delete("/addon-groups/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.query(`DELETE FROM addon_groups WHERE id = ?`, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /addon-groups/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to delete group" });
  }
});

// ================== CREATE an addon item ==================
router.post("/addons", async (req, res) => {
  try {
    const { name, price, is_veg = true, is_available = true, addon_group_id } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Add-on name is required" });
    }
    if (price === undefined || isNaN(price) || Number(price) < 0) {
      return res.status(400).json({ success: false, message: "Valid price is required" });
    }
    if (!addon_group_id) {
      return res.status(400).json({ success: false, message: "addon_group_id is required" });
    }

    const [result] = await db.query(
      `INSERT INTO addons (addon_group_id, name, price, is_veg, is_available)
       VALUES (?, ?, ?, ?, ?)`,
      [addon_group_id, name.trim(), price, !!is_veg, !!is_available]
    );

    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("POST /addons error:", err);
    res.status(500).json({ success: false, message: "Failed to create add-on" });
  }
});

// ================== UPDATE an addon item ==================
router.put("/addons/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, is_veg, is_available } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Add-on name is required" });
    }
    if (price === undefined || isNaN(price) || Number(price) < 0) {
      return res.status(400).json({ success: false, message: "Valid price is required" });
    }

    const [result] = await db.query(
      `UPDATE addons SET name = ?, price = ?, is_veg = ?, is_available = ? WHERE id = ?`,
      [name.trim(), price, !!is_veg, !!is_available, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Add-on not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("PUT /addons/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to update add-on" });
  }
});

// ================== PATCH availability only (fast toggle) ==================
router.patch("/addons/:id/availability", async (req, res) => {
  try {
    const { id } = req.params;
    const { is_available } = req.body;

    if (typeof is_available !== "boolean") {
      return res.status(400).json({ success: false, message: "is_available must be boolean" });
    }

    const [result] = await db.query(
      `UPDATE addons SET is_available = ? WHERE id = ?`,
      [is_available, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Add-on not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /addons/:id/availability error:", err);
    res.status(500).json({ success: false, message: "Failed to update availability" });
  }
});

// ================== DELETE an addon item ==================
router.delete("/addons/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.query(`DELETE FROM addons WHERE id = ?`, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Add-on not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /addons/:id error:", err);
    res.status(500).json({ success: false, message: "Failed to delete add-on" });
  }
});

// ================== Get groups assigned to a specific menu item ==================
router.get("/menu-items/:menuItemId/addon-groups", async (req, res) => {
  try {
    const { menuItemId } = req.params;
    const [rows] = await db.query(
      `SELECT ag.id, ag.name
       FROM menu_item_addon_groups miag
       JOIN addon_groups ag ON ag.id = miag.addon_group_id
       WHERE miag.menu_item_id = ?`,
      [menuItemId]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /menu-items/:id/addon-groups error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch assigned groups" });
  }
});

// ================== Assign/replace groups for a menu item ==================
router.put("/menu-items/:menuItemId/addon-groups", async (req, res) => {
  const { menuItemId } = req.params;
  const { addon_group_ids = [] } = req.body;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      `DELETE FROM menu_item_addon_groups WHERE menu_item_id = ?`,
      [menuItemId]
    );

    if (addon_group_ids.length) {
      const values = addon_group_ids.map((groupId) => [menuItemId, groupId]);
      await connection.query(
        `INSERT INTO menu_item_addon_groups (menu_item_id, addon_group_id) VALUES ?`,
        [values]
      );
    }

    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    console.error("PUT /menu-items/:id/addon-groups error:", err);
    res.status(500).json({ success: false, message: "Failed to assign groups" });
  } finally {
    connection.release();
  }
});

module.exports = router;