const express = require("express");
const pool = require("../db");
const { authenticateSuperadmin } = require("./superadmin");
const router = express.Router();

router.use(authenticateSuperadmin);

// GET all categories, with a live count of menu items in each
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.name, COUNT(m.id) AS item_count
      FROM categories c
      LEFT JOIN menu_items m ON m.category_id = c.id
      GROUP BY c.id, c.name
      ORDER BY c.name
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Superadmin Categories Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch categories" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Category name is required" });
    }

    const [existing] = await pool.query("SELECT id FROM categories WHERE name = ?", [name.trim()]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: "Category already exists" });
    }

    await pool.query("INSERT INTO categories (name) VALUES (?)", [name.trim()]);
    res.json({ success: true, message: "Category added successfully" });
  } catch (err) {
    console.error("Superadmin Category Insert Error:", err);
    res.status(500).json({ success: false, message: "Failed to add category" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Category name is required" });
    }
    const trimmedName = name.trim();

    const [rows] = await pool.query("SELECT id FROM categories WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    const [existing] = await pool.query(
      "SELECT id FROM categories WHERE name = ? AND id != ?",
      [trimmedName, id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: "Another category with this name already exists" });
    }

    await pool.query("UPDATE categories SET name = ? WHERE id = ?", [trimmedName, id]);
    res.json({ success: true, message: "Category updated successfully" });
  } catch (err) {
    console.error("Superadmin Category Update Error:", err);
    res.status(500).json({ success: false, message: "Failed to update category" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query("SELECT id FROM categories WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    const [inUse] = await pool.query("SELECT COUNT(*) AS c FROM menu_items WHERE category_id = ?", [id]);
    if (inUse[0].c > 0) {
      return res.status(400).json({
        success: false,
        message: `Can't delete — ${inUse[0].c} menu item(s) still use this category.`
      });
    }

    await pool.query("DELETE FROM categories WHERE id = ?", [id]);
    res.json({ success: true, message: "Category deleted successfully" });
  } catch (err) {
    console.error("Superadmin Category Delete Error:", err);
    res.status(500).json({ success: false, message: "Failed to delete category" });
  }
});

module.exports = router;