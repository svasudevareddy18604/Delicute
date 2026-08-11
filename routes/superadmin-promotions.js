const express = require("express");
const router = express.Router();
const cloudinary = require("cloudinary").v2;
const { Readable } = require("stream");
const pool = require("../db");
const { authenticateSuperadmin } = require("./superadmin");
const path = require("path");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const multer = require("multer");
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (extname && mimetype) return cb(null, true);
    cb(new Error("Only JPEG and PNG images are allowed"));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

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

function formatToDateOnly(date) {
  if (!date || `${date}`.trim() === "") return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0];
}

router.use(authenticateSuperadmin);

/* ================= GET all promotions ================= */
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, title, description, image, DATE(start_date) as start_date, DATE(end_date) as end_date, created_at
      FROM promotions
      ORDER BY created_at DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Superadmin Promotions Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch promotions" });
  }
});

/* ================= GET single promotion ================= */
router.get("/:id", async (req, res) => {
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
    console.error("Superadmin Promotion Single Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch promotion" });
  }
});

/* ================= ADD promotion ================= */
router.post("/", upload.single("image"), async (req, res) => {
  try {
    const { title, description, start_date, end_date } = req.body;
    const hasFile = !!req.file;

    const trimmedTitle = title && title.trim() !== "" ? title.trim() : null;
    const trimmedDescription = description && description.trim() !== "" ? description.trim() : null;

    if (!trimmedTitle && !trimmedDescription && !start_date && !end_date && !hasFile) {
      return res.status(400).json({ success: false, message: "Please provide at least one field" });
    }

    const formattedStartDate = formatToDateOnly(start_date);
    const formattedEndDate = formatToDateOnly(end_date);

    if (formattedStartDate && formattedEndDate && new Date(formattedEndDate) < new Date(formattedStartDate)) {
      return res.status(400).json({ success: false, message: "End date must be after start date" });
    }

    let imageUrl = null;
    if (hasFile) {
      imageUrl = await uploadToCloudinary(req.file.buffer, req.file.originalname);
    }

    const [result] = await pool.query(
      `INSERT INTO promotions (title, description, image, start_date, end_date)
       VALUES (?, ?, ?, ?, ?)`,
      [trimmedTitle, trimmedDescription, imageUrl, formattedStartDate, formattedEndDate]
    );

    const newPromotion = {
      id: result.insertId,
      title: trimmedTitle,
      description: trimmedDescription,
      image: imageUrl,
      start_date: formattedStartDate,
      end_date: formattedEndDate,
      created_at: new Date(),
    };

    const io = req.app.get("io");
    if (io) io.emit("new-promotion", newPromotion);

    res.status(201).json({ success: true, data: newPromotion, message: "Promotion added successfully" });
  } catch (err) {
    console.error("Superadmin Promotion Insert Error:", err);
    res.status(500).json({ success: false, message: "Failed to add promotion" });
  }
});

/* ================= UPDATE promotion ================= */
router.put("/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, start_date, end_date } = req.body;

    const [existingRows] = await pool.query(
      `SELECT id, title, description, image, DATE(start_date) as start_date, DATE(end_date) as end_date
       FROM promotions WHERE id = ?`,
      [id]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ success: false, message: "Promotion not found" });
    }
    const existing = existingRows[0];

    const fields = [];
    const values = [];

    if (title !== undefined) {
      fields.push("title = ?");
      values.push(title.trim() === "" ? null : title.trim());
    }
    if (description !== undefined) {
      fields.push("description = ?");
      values.push(description.trim() === "" ? null : description.trim());
    }

    let effectiveStart = existing.start_date;
    let effectiveEnd = existing.end_date;

    if (start_date !== undefined) {
      effectiveStart = formatToDateOnly(start_date);
      fields.push("start_date = ?");
      values.push(effectiveStart);
    }
    if (end_date !== undefined) {
      effectiveEnd = formatToDateOnly(end_date);
      fields.push("end_date = ?");
      values.push(effectiveEnd);
    }

    if (effectiveStart && effectiveEnd && new Date(effectiveEnd) < new Date(effectiveStart)) {
      return res.status(400).json({ success: false, message: "End date must be after start date" });
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
    const [result] = await pool.query(`UPDATE promotions SET ${fields.join(", ")} WHERE id = ?`, values);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Promotion not found" });
    }

    const io = req.app.get("io");
    const [updatedPromotion] = await pool.query(
      `SELECT id, title, description, image, DATE(start_date) as start_date, DATE(end_date) as end_date, created_at
       FROM promotions WHERE id = ?`,
      [id]
    );
    if (io) io.emit("update-promotion", updatedPromotion[0]);

    res.json({ success: true, data: updatedPromotion[0], message: "Promotion updated successfully" });
  } catch (err) {
    console.error("Superadmin Promotion Update Error:", err);
    res.status(500).json({ success: false, message: "Failed to update promotion" });
  }
});

/* ================= DELETE promotion ================= */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query("DELETE FROM promotions WHERE id = ?", [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Promotion not found" });
    }
    const io = req.app.get("io");
    if (io) io.emit("delete-promotion", { id });
    res.json({ success: true, message: "Promotion deleted" });
  } catch (err) {
    console.error("Superadmin Promotion Delete Error:", err);
    res.status(500).json({ success: false, message: "Failed to delete promotion" });
  }
});

module.exports = router;