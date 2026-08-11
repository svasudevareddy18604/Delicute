const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateSuperadmin } = require("./superadmin");

router.use(authenticateSuperadmin);

// ================== GET ALL MENU ITEMS (with top-pick flag) ==================
// GET /api/superadmin/toppicks
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, name, category, price, original_price, image, is_top_pick
      FROM menu_items
      ORDER BY name ASC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Superadmin top picks fetch error:", err);
    res.status(500).json({ success: false, message: "Failed to load menu items" });
  }
});

// ================== ADD TO TOP PICKS ==================
// POST /api/superadmin/toppicks/:id
router.post("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      `UPDATE menu_items SET is_top_pick = 1 WHERE id = ?`,
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }
    res.json({ success: true, message: "Added to Top Picks" });
  } catch (err) {
    console.error("Superadmin add top pick error:", err);
    res.status(500).json({ success: false, message: "Failed to add to Top Picks" });
  }
});

// ================== REMOVE FROM TOP PICKS ==================
// DELETE /api/superadmin/toppicks/:id
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      `UPDATE menu_items SET is_top_pick = 0 WHERE id = ?`,
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }
    res.json({ success: true, message: "Removed from Top Picks" });
  } catch (err) {
    console.error("Superadmin remove top pick error:", err);
    res.status(500).json({ success: false, message: "Failed to remove from Top Picks" });
  }
});

module.exports = router;