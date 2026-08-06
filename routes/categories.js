const express = require("express");
const pool = require("../db");
const router = express.Router();

/**
 * GET /api/categories
 * Fetch all categories
 */
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name FROM categories ORDER BY name"
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("❌ Categories Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch categories" });
  }
});

/**
 * POST /api/categories
 * Add a new category
 */
router.post("/", async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Category name is required" });
    }

    // Check if category already exists
    const [existing] = await pool.query("SELECT id FROM categories WHERE name = ?", [name.trim()]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: "Category already exists" });
    }

    await pool.query("INSERT INTO categories (name) VALUES (?)", [name.trim()]);
    res.json({ success: true, message: "Category added successfully" });
  } catch (err) {
    console.error("❌ Category Insert Error:", err);
    res.status(500).json({ success: false, message: "Failed to add category" });
  }
});

/**
 * DELETE /api/categories/:id
 * Delete a category
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Check if category exists
    const [rows] = await pool.query("SELECT id FROM categories WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    await pool.query("DELETE FROM categories WHERE id = ?", [id]);
    res.json({ success: true, message: "Category deleted successfully" });
  } catch (err) {
    console.error("❌ Category Delete Error:", err);
    res.status(500).json({ success: false, message: "Failed to delete category" });
  }
});

module.exports = router;
