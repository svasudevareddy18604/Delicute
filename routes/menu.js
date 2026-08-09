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

// ✅ Helper: normalize + validate size (now works for ANY category)
const VALID_SIZES = ["SMALL", "REGULAR", "MEDIUM", "LARGE"];
function normalizeSize(size) {
  if (!size) return null;
  const upper = String(size).toUpperCase();
  return VALID_SIZES.includes(upper) ? upper : null;
}

// ✅ Helper: normalize + validate food_type
function normalizeFoodType(food_type) {
  return food_type === "nonveg" ? "nonveg" : "veg"; // defaults to veg if missing/invalid
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
        m.food_type,
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
      `SELECT id, name, description, price, original_price, saved_price, category_id, image, size, food_type, is_top_pick 
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
    const { name, description, original_price, saved_price, category_id, size, food_type } = req.body;

    if (!name || !original_price || !category_id) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Image is required" });
    }

    // Upload image to Cloudinary
    const imageUrl = await uploadToCloudinary(req.file.buffer, req.file.originalname);

    const finalPrice = parseFloat(original_price) - parseFloat(saved_price || 0);

    // Size is now optional for ANY category — not restricted to "pizza" anymore.
    // If the admin ticked "has sizes" on the frontend, `size` will be present; otherwise it's omitted.
    const sizeValue = normalizeSize(size);
    const foodTypeValue = normalizeFoodType(food_type);

    await pool.query(
      `INSERT INTO menu_items 
       (name, description, price, original_price, saved_price, category_id, image, size, food_type, is_top_pick) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [name, description || null, finalPrice, original_price, saved_price || 0, category_id, imageUrl, sizeValue, foodTypeValue]
    );

    res.json({ success: true, message: "Menu item added successfully" });
  } catch (err) {
    console.error("Menu Insert Error:", err);
    res.status(500).json({ success: false, message: "Failed to add menu item" });
  }
});

/* ================================
   UPDATE menu item
   (partial update — only touches fields actually sent;
   image stays untouched unless a new file is uploaded)
================================ */
router.put("/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, original_price, saved_price, category_id, size, food_type } = req.body;

    // Recalculate price only if original_price was sent
    const finalPrice = original_price
      ? parseFloat(original_price) - parseFloat(saved_price || 0)
      : null;

    // Only upload a new image if one was actually sent —
    // the frontend deliberately omits "image" from FormData when unchanged.
    let imageUrl;
    if (req.file) {
      imageUrl = await uploadToCloudinary(req.file.buffer, req.file.originalname);
    }

    // Build update query dynamically — only include fields present in the request
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

    // Size: only overwrite if the field was actually sent in this request.
    // If the admin's edit form had "has sizes" unchecked, `size` won't be
    // in the body at all — in that case we still explicitly clear it,
    // since unchecking is a deliberate choice to remove the size.
    if (size !== undefined) {
      fields.push("size = ?");
      values.push(normalizeSize(size));
    }

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
    res.status(500).json({ success: false, message: "Failed to add top pick" });
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