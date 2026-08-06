const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { Readable } = require("stream");
const pool = require("../db"); // mysql pool
const router = express.Router();

// ✅ Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ✅ Multer memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ✅ Helper to upload file buffer to Cloudinary
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

/* ================================
   GET all menu items
================================ */
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        m.id, 
        m.name, 
        m.description, 
        m.price, 
        m.original_price,
        m.saved_price,
        m.category_id,
        c.name AS category,
        m.image,
        m.size,
        m.is_top_pick
      FROM menu_items m
      JOIN categories c ON m.category_id = c.id
      ORDER BY m.id DESC
    `);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Menu Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch menu" });
  }
});

/* ================================
   GET single menu item by ID
================================ */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      `SELECT id, name, description, price, original_price, saved_price, category_id, image, size, is_top_pick 
       FROM menu_items WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Menu item not found" });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("Menu Single Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch menu item" });
  }
});

/* ================================
   ADD new menu item
================================ */
router.post("/", upload.single("image"), async (req, res) => {
  try {
    const { name, description, original_price, saved_price, category_id, size } = req.body;
    if (!name || !original_price || !category_id) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Image is required" });
    }

    // Upload image to Cloudinary
    const imageUrl = await uploadToCloudinary(req.file.buffer, req.file.originalname);

    const finalPrice = parseFloat(original_price) - parseFloat(saved_price || 0);

    // Validate size (only for VEG PIZZAS and NON-VEG PIZZAS)
    const [category] = await pool.query("SELECT name FROM categories WHERE id = ?", [category_id]);
    const validSizes = ["REGULAR", "MEDIUM", "LARGE"];
    const sizeValue = category.length > 0 && category[0].name.toLowerCase().includes("pizza") && validSizes.includes(size?.toUpperCase())
      ? size.toUpperCase()
      : null;

    await pool.query(
      `INSERT INTO menu_items 
       (name, description, price, original_price, saved_price, category_id, image, size, is_top_pick) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [name, description || null, finalPrice, original_price, saved_price || 0, category_id, imageUrl, sizeValue]
    );

    res.json({ success: true, message: "Menu item added successfully" });
  } catch (err) {
    console.error("Menu Insert Error:", err);
    res.status(500).json({ success: false, message: "Failed to add menu item" });
  }
});

/* ================================
   UPDATE menu item
================================ */
router.put("/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, original_price, saved_price, category_id, size } = req.body;

    // Calculate price
    const finalPrice = original_price
      ? parseFloat(original_price) - parseFloat(saved_price || 0)
      : null;

    // If new image uploaded
    let imageUrl;
    if (req.file) {
      imageUrl = await uploadToCloudinary(req.file.buffer, req.file.originalname);
    }

    // Validate size (only for VEG PIZZAS and NON-VEG PIZZAS)
    let sizeValue = null;
    if (category_id) {
      const [category] = await pool.query("SELECT name FROM categories WHERE id = ?", [category_id]);
      const validSizes = ["REGULAR", "MEDIUM", "LARGE"];
      sizeValue = category.length > 0 && category[0].name.toLowerCase().includes("pizza") && validSizes.includes(size?.toUpperCase())
        ? size.toUpperCase()
        : null;
    }

    // Build update query dynamically
    const fields = [];
    const values = [];

    if (name) { fields.push("name = ?"); values.push(name); }
    if (description !== undefined) { fields.push("description = ?"); values.push(description); }
    if (original_price) { fields.push("original_price = ?"); values.push(original_price); }
    if (saved_price !== undefined) { fields.push("saved_price = ?"); values.push(saved_price); }
    if (finalPrice !== null) { fields.push("price = ?"); values.push(finalPrice); }
    if (category_id) { fields.push("category_id = ?"); values.push(category_id); }
    if (imageUrl) { fields.push("image = ?"); values.push(imageUrl); }
    fields.push("size = ?"); values.push(sizeValue);

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    values.push(id);

    await pool.query(
      `UPDATE menu_items SET ${fields.join(", ")} WHERE id = ?`,
      values
    );

    res.json({ success: true, message: "Menu item updated successfully" });
  } catch (err) {
    console.error("Menu Update Error:", err);
    res.status(500).json({ success: false, message: "Failed to update menu item" });
  }
});

/* ================================
   DELETE menu item
================================ */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM menu_items WHERE id = ?", [id]);
    res.json({ success: true, message: "Menu item deleted" });
  } catch (err) {
    console.error("Menu Delete Error:", err);
    res.status(500).json({ success: false, message: "Failed to delete menu item" });
  }
});

/* ================================
   ✅ TOP PICKS MANAGEMENT
================================ */
// Add to Top Picks
router.post("/top-picks/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE menu_items SET is_top_pick = 1 WHERE id = ?", [id]);
    res.json({ success: true, message: "Item added to Top Picks" });
  } catch (err) {
    console.error("Top Pick Add Error:", err);
    res.status(500). Promisedjson({ success: false, message: "Failed to add top pick" });
  }
});

// Remove from Top Picks
router.delete("/top-picks/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE menu_items SET is_top_pick = 0 WHERE id = ?", [id]);
    res.json({ success: true, message: "Item removed from Top Picks" });
  } catch (err) {
    console.error("Top Pick Remove Error:", err);
    res.status(500).json({ success: false, message: "Failed to remove top pick" });
  }
});

module.exports = router;