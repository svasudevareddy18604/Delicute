const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { Readable } = require("stream");
const pool = require("../db");
const { authenticateSuperadmin } = require("./superadmin");
const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = multer.memoryStorage();
const upload = multer({ storage });

async function uploadToCloudinary(fileBuffer, filename) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: "menu_items", public_id: filename.split(".")[0] },
      (err, result) => {
        if (err) reject(err);
        else resolve(result.secure_url);
      }
    );
    Readable.from(fileBuffer).pipe(uploadStream);
  });
}

const VALID_SIZES = ["SMALL", "REGULAR", "MEDIUM", "LARGE"];
function normalizeSize(size) {
  if (!size) return null;
  const upper = String(size).toUpperCase();
  return VALID_SIZES.includes(upper) ? upper : null;
}
function normalizeFoodType(food_type) {
  return food_type === "nonveg" ? "nonveg" : "veg";
}

// Every route below requires a valid superadmin session.
router.use(authenticateSuperadmin);

/* ================= GET all menu items ================= */
router.get("/", async (req, res) => {
  try {
    const { category_id, food_type, q } = req.query;
    const where = [];
    const params = [];

    if (category_id) { where.push("m.category_id = ?"); params.push(category_id); }
    if (food_type === "veg" || food_type === "nonveg") { where.push("m.food_type = ?"); params.push(food_type); }
    if (q && q.trim()) { where.push("m.name LIKE ?"); params.push(`%${q.trim()}%`); }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await pool.query(`
      SELECT m.id, m.name, m.description, m.price, m.original_price, m.saved_price,
             m.category_id, c.name AS category, m.image, m.size, m.food_type, m.is_top_pick
      FROM menu_items m
      JOIN categories c ON m.category_id = c.id
      ${whereSql}
      ORDER BY m.id DESC
    `, params);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Superadmin Menu Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch menu" });
  }
});

/* ================= GET single item ================= */
router.get("/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, description, price, original_price, saved_price, category_id, image, size, food_type, is_top_pick
       FROM menu_items WHERE id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: "Menu item not found" });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("Superadmin Menu Single Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch menu item" });
  }
});

/* ================= CREATE ================= */
router.post("/", upload.single("image"), async (req, res) => {
  try {
    const { name, description, original_price, saved_price, category_id, size, food_type } = req.body;

    if (!name || !original_price || !category_id) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Image is required" });
    }

    const imageUrl = await uploadToCloudinary(req.file.buffer, req.file.originalname);
    const finalPrice = parseFloat(original_price) - parseFloat(saved_price || 0);
    const sizeValue = normalizeSize(size);
    const foodTypeValue = normalizeFoodType(food_type);

    const [result] = await pool.query(
      `INSERT INTO menu_items (name, description, price, original_price, saved_price, category_id, image, size, food_type, is_top_pick)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [name, description || null, finalPrice, original_price, saved_price || 0, category_id, imageUrl, sizeValue, foodTypeValue]
    );

    const io = req.app.get("io");
    if (io) io.emit("menu-item-created", { id: result.insertId });

    res.json({ success: true, message: "Menu item added successfully" });
  } catch (err) {
    console.error("Superadmin Menu Insert Error:", err);
    res.status(500).json({ success: false, message: "Failed to add menu item" });
  }
});

/* ================= UPDATE ================= */
router.put("/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, original_price, saved_price, category_id, size, food_type } = req.body;

    const finalPrice = original_price
      ? parseFloat(original_price) - parseFloat(saved_price || 0)
      : null;

    let imageUrl;
    if (req.file) {
      imageUrl = await uploadToCloudinary(req.file.buffer, req.file.originalname);
    }

    const fields = [];
    const values = [];

    if (name) { fields.push("name = ?"); values.push(name); }
    if (description !== undefined) { fields.push("description = ?"); values.push(description); }
    if (original_price) { fields.push("original_price = ?"); values.push(original_price); }
    if (saved_price !== undefined) { fields.push("saved_price = ?"); values.push(saved_price); }
    if (finalPrice !== null) { fields.push("price = ?"); values.push(finalPrice); }
    if (category_id) { fields.push("category_id = ?"); values.push(category_id); }
    if (imageUrl) { fields.push("image = ?"); values.push(imageUrl); }
    if (food_type !== undefined) { fields.push("food_type = ?"); values.push(normalizeFoodType(food_type)); }
    if (size !== undefined) { fields.push("size = ?"); values.push(normalizeSize(size)); }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    values.push(id);
    await pool.query(`UPDATE menu_items SET ${fields.join(", ")} WHERE id = ?`, values);

    const io = req.app.get("io");
    if (io) io.emit("menu-item-updated", { id: Number(id) });

    res.json({ success: true, message: "Menu item updated successfully" });
  } catch (err) {
    console.error("Superadmin Menu Update Error:", err);
    res.status(500).json({ success: false, message: "Failed to update menu item" });
  }
});

/* ================= DELETE ================= */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM menu_items WHERE id = ?", [id]);

    const io = req.app.get("io");
    if (io) io.emit("menu-item-deleted", { id: Number(id) });

    res.json({ success: true, message: "Menu item deleted" });
  } catch (err) {
    console.error("Superadmin Menu Delete Error:", err);
    res.status(500).json({ success: false, message: "Failed to delete menu item" });
  }
});

/* ================= TOP PICKS ================= */
router.post("/top-picks/:id", async (req, res) => {
  try {
    await pool.query("UPDATE menu_items SET is_top_pick = 1 WHERE id = ?", [req.params.id]);
    const io = req.app.get("io");
    if (io) io.emit("menu-item-updated", { id: Number(req.params.id) });
    res.json({ success: true, message: "Item added to Top Picks" });
  } catch (err) {
    console.error("Superadmin Top Pick Add Error:", err);
    res.status(500).json({ success: false, message: "Failed to add top pick" });
  }
});

router.delete("/top-picks/:id", async (req, res) => {
  try {
    await pool.query("UPDATE menu_items SET is_top_pick = 0 WHERE id = ?", [req.params.id]);
    const io = req.app.get("io");
    if (io) io.emit("menu-item-updated", { id: Number(req.params.id) });
    res.json({ success: true, message: "Item removed from Top Picks" });
  } catch (err) {
    console.error("Superadmin Top Pick Remove Error:", err);
    res.status(500).json({ success: false, message: "Failed to remove top pick" });
  }
});

module.exports = router;