const express = require("express");
const multer = require("multer");
const streamifier = require("streamifier");
const cloudinary = require("cloudinary").v2;
const pool = require("../db");
const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  }
});

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "delicute/categories",
        transformation: [{ width: 500, height: 500, crop: "fill", gravity: "auto" }]
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

function getPublicIdFromUrl(url) {
  if (!url) return null;
  try {
    const idx = url.indexOf("/delicute/categories/");
    if (idx === -1) return null;
    const afterFolder = url.substring(idx + 1); // "delicute/categories/xyz.jpg"
    return afterFolder.replace(/\.[^/.]+$/, ""); // strip extension
  } catch {
    return null;
  }
}

/**
 * GET /api/categories
 */
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, name, image FROM categories ORDER BY name");
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("❌ Categories Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch categories" });
  }
});

/**
 * POST /api/categories  (multipart/form-data: name, image?)
 */
router.post("/", upload.single("image"), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Category name is required" });
    }
    const trimmedName = name.trim();

    const [existing] = await pool.query("SELECT id FROM categories WHERE name = ?", [trimmedName]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: "Category already exists" });
    }

    let imageUrl = null;
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer);
      imageUrl = result.secure_url;
    }

    await pool.query("INSERT INTO categories (name, image) VALUES (?, ?)", [trimmedName, imageUrl]);
    res.json({ success: true, message: "Category added successfully" });
  } catch (err) {
    console.error("❌ Category Insert Error:", err);
    res.status(500).json({ success: false, message: "Failed to add category" });
  }
});

/**
 * PUT /api/categories/:id  (multipart/form-data: name, image?)
 */
router.put("/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Category name is required" });
    }
    const trimmedName = name.trim();

    const [rows] = await pool.query("SELECT id, image FROM categories WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    const [dup] = await pool.query(
      "SELECT id FROM categories WHERE name = ? AND id != ?",
      [trimmedName, id]
    );
    if (dup.length > 0) {
      return res.status(400).json({ success: false, message: "Another category with this name already exists" });
    }

    let imageUrl = rows[0].image;
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer);
      imageUrl = result.secure_url;

      const oldPublicId = getPublicIdFromUrl(rows[0].image);
      if (oldPublicId) cloudinary.uploader.destroy(oldPublicId).catch(() => {});
    }

    await pool.query("UPDATE categories SET name = ?, image = ? WHERE id = ?", [trimmedName, imageUrl, id]);
    res.json({ success: true, message: "Category updated successfully" });
  } catch (err) {
    console.error("❌ Category Update Error:", err);
    res.status(500).json({ success: false, message: "Failed to update category" });
  }
});

/**
 * DELETE /api/categories/:id
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query("SELECT id, image FROM categories WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    await pool.query("DELETE FROM categories WHERE id = ?", [id]);

    const publicId = getPublicIdFromUrl(rows[0].image);
    if (publicId) cloudinary.uploader.destroy(publicId).catch(() => {});

    res.json({ success: true, message: "Category deleted successfully" });
  } catch (err) {
    console.error("❌ Category Delete Error:", err);
    res.status(500).json({ success: false, message: "Failed to delete category" });
  }
});

module.exports = router;