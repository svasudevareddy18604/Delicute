const express = require("express");
const router = express.Router();
const cloudinary = require("cloudinary").v2;
const { Readable } = require("stream");
const pool = require("../db"); // MySQL pool
const authenticate = require("../middleware/authenticate"); // Use provided authenticate middleware
const path = require("path");

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer memory storage
const multer = require("multer");
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error("Only JPEG and PNG images are allowed"));
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Helper to upload file buffer to Cloudinary
async function uploadToCloudinary(fileBuffer, filename) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: "promotions", public_id: filename.split(".")[0] },
      (err, result) => {
        if (err) reject(err);
        else resolve(result.secure_url);
      }
    );
    Readable.from(fileBuffer).pipe(uploadStream);
  });
}

// Helper to format date to YYYY-MM-DD
function formatToDateOnly(date) {
  return new Date(date).toISOString().split('T')[0];
}

/* ================================
   GET all promotions
================================ */
router.get("/", authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, title, description, image, DATE(start_date) as start_date, DATE(end_date) as end_date, created_at
      FROM promotions
      ORDER BY created_at DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Promotions Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch promotions" });
  }
});

/* ================================
   GET single promotion by ID
================================ */
router.get("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      `SELECT id, title, description, image, DATE(start_date) as start_date, DATE(end_date) as end_date, created_at
       FROM promotions WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Promotion not found" });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("Promotion Single Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch promotion" });
  }
});

/* ================================
   ADD new promotion
================================ */
router.post("/", authenticate, upload.single("image"), async (req, res) => {
  try {
    const { title, description, start_date, end_date } = req.body;
    if (!title || !description || !start_date || !end_date || !req.file) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    const formattedStartDate = formatToDateOnly(start_date);
    const formattedEndDate = formatToDateOnly(end_date);

    if (new Date(formattedEndDate) < new Date(formattedStartDate)) {
      return res.status(400).json({ success: false, message: "End date must be after start date" });
    }

    // Upload image to Cloudinary
    const imageUrl = await uploadToCloudinary(req.file.buffer, req.file.originalname);

    const [result] = await pool.query(
      `INSERT INTO promotions (title, description, image, start_date, end_date)
       VALUES (?, ?, ?, ?, ?)`,
      [title, description, imageUrl, formattedStartDate, formattedEndDate]
    );

    const newPromotion = {
      id: result.insertId,
      title,
      description,
      image: imageUrl,
      start_date: formattedStartDate,
      end_date: formattedEndDate,
      created_at: new Date(),
    };

    // Emit WebSocket event
    const io = req.app.get("io");
    io.emit("new-promotion", newPromotion);

    res.status(201).json({ success: true, data: newPromotion, message: "Promotion added successfully" });
  } catch (err) {
    console.error("Promotion Insert Error:", err);
    res.status(500).json({ success: false, message: "Failed to add promotion" });
  }
});

/* ================================
   UPDATE promotion
================================ */
router.put("/:id", authenticate, upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, start_date, end_date } = req.body;

    // Build update query dynamically
    const fields = [];
    const values = [];

    if (title) {
      fields.push("title = ?");
      values.push(title);
    }
    if (description !== undefined) {
      fields.push("description = ?");
      values.push(description);
    }
    if (start_date) {
      const formattedStartDate = formatToDateOnly(start_date);
      fields.push("start_date = ?");
      values.push(formattedStartDate);
    }
    if (end_date) {
      const formattedEndDate = formatToDateOnly(end_date);
      if (start_date && new Date(formattedEndDate) < new Date(formatToDateOnly(start_date))) {
        return res.status(400).json({ success: false, message: "End date must be after start date" });
      }
      fields.push("end_date = ?");
      values.push(formattedEndDate);
    }
    if (req.file) {
      const imageUrl = await uploadToCloudinary(req.file.buffer, req.file.originalname);
      fields.push("image = ?");
      values.push(imageUrl);
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    values.push(id);

    const [result] = await pool.query(
      `UPDATE promotions SET ${fields.join(", ")} WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Promotion not found" });
    }

    // Emit WebSocket event for update
    const io = req.app.get("io");
    const [updatedPromotion] = await pool.query(
      `SELECT id, title, description, image, DATE(start_date) as start_date, DATE(end_date) as end_date, created_at
       FROM promotions WHERE id = ?`,
      [id]
    );
    io.emit("update-promotion", updatedPromotion[0]);

    res.json({ success: true, message: "Promotion updated successfully" });
  } catch (err) {
    console.error("Promotion Update Error:", err);
    res.status(500).json({ success: false, message: "Failed to update promotion" });
  }
});

/* ================================
   DELETE promotion
================================ */
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query("DELETE FROM promotions WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Promotion not found" });
    }

    // Emit WebSocket event
    const io = req.app.get("io");
    io.emit("delete-promotion", { id });

    res.json({ success: true, message: "Promotion deleted" });
  } catch (err) {
    console.error("Promotion Delete Error:", err);
    res.status(500).json({ success: false, message: "Failed to delete promotion" });
  }
});

module.exports = router;