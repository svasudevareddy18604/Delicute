const express = require("express");
const router = express.Router();
const pool = require("../db");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { Readable } = require("stream");
const { authenticateSuperadmin } = require("./superadmin");

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
      { folder: "coupons", public_id: filename.split(".")[0] },
      (err, result) => {
        if (err) reject(err);
        else resolve(result.secure_url);
      }
    );
    Readable.from(fileBuffer).pipe(uploadStream);
  });
}

const VALID_COUPON_TYPES = ["buy_x", "date_range", "min_cart_amount", "bogo", "cart_tier"];
const ACTIVE_TYPES = ["min_cart_amount", "cart_tier"];

function validateTiers(rawTiers) {
  let tiers;
  try {
    tiers = typeof rawTiers === "string" ? JSON.parse(rawTiers) : rawTiers;
  } catch {
    return { error: "Tiers must be valid JSON" };
  }

  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { error: "At least one cart tier is required" };
  }

  const cleaned = [];
  const seenAmounts = new Set();

  for (const t of tiers) {
    const amount = Number(t.amount ?? t.min_cart_amount);
    const discount = Number(t.discount);

    if (!Number.isFinite(amount) || amount < 0) {
      return { error: "Each tier needs a non-negative cart amount" };
    }
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      return { error: "Each tier's discount must be between 0 and 100" };
    }
    if (seenAmounts.has(amount)) {
      return { error: `Duplicate tier for cart amount ₹${amount}` };
    }
    seenAmounts.add(amount);
    cleaned.push({ amount, discount });
  }

  cleaned.sort((a, b) => a.amount - b.amount);
  return { tiers: cleaned };
}

async function validateCouponPayload(body) {
  const { code, description, discount, min_cart_amount, free_item, type, tiers } = body;

  if (!code || !description) {
    return { error: "Code and description are required" };
  }

  const resolvedType = type || "min_cart_amount";
  if (!ACTIVE_TYPES.includes(resolvedType)) {
    if (!VALID_COUPON_TYPES.includes(resolvedType)) {
      return { error: "Invalid coupon type" };
    }
    return {
      error: `Creating "${resolvedType}" coupons is temporarily disabled — only ${ACTIVE_TYPES.join(" and ")} coupons can be created right now`,
    };
  }

  if (resolvedType === "cart_tier") {
    const tierResult = validateTiers(tiers);
    if (tierResult.error) return { error: tierResult.error };

    return {
      code,
      description,
      type: "cart_tier",
      discountValue: 0,
      minCartValue: null,
      freeItemValue: null,
      tiersValue: JSON.stringify(tierResult.tiers),
    };
  }

  const hasDiscount = discount != null && discount !== "";
  const hasFreeItem = typeof free_item === "string" && free_item.trim() !== "";

  if (!hasDiscount && !hasFreeItem) {
    return { error: "Discount or free item is required" };
  }

  let discountValue = 0;
  if (hasDiscount) {
    const d = Number(discount);
    if (!Number.isFinite(d) || d < 0 || d > 100) {
      return { error: "Discount must be a number between 0 and 100" };
    }
    discountValue = hasFreeItem ? 0 : d;
  }

  let minCartValue = null;
  if (min_cart_amount != null && min_cart_amount !== "") {
    const m = Number(min_cart_amount);
    if (!Number.isFinite(m) || m < 0) {
      return { error: "Minimum cart amount must be a non-negative number" };
    }
    minCartValue = m;
  }

  return {
    code,
    description,
    type: "min_cart_amount",
    discountValue,
    minCartValue,
    freeItemValue: hasFreeItem ? free_item.trim() : null,
    tiersValue: null,
  };
}

router.use(authenticateSuperadmin);

// ================= GET ALL COUPONS =================
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.code, c.description, c.image, c.discount, c.quantity,
              c.type, c.buy_x, c.valid_from, c.valid_to, c.min_cart_amount,
              c.free_item, c.tiers, cat.name AS category
       FROM coupons c
       LEFT JOIN categories cat ON c.category_id = cat.id
       ORDER BY c.id DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Superadmin Coupons Fetch Error:", err.message);
    res.status(500).json({ success: false, message: "Failed to fetch coupons" });
  }
});

// ================= GET ONE COUPON =================
router.get("/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, cat.name AS category
       FROM coupons c
       LEFT JOIN categories cat ON c.category_id = cat.id
       WHERE c.id = ?`,
      [req.params.id]
    );
    if (rows.length === 0)
      return res.status(404).json({ success: false, message: "Coupon not found" });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("Superadmin Fetch One Coupon Error:", err.message);
    res.status(500).json({ success: false, message: "Failed to fetch coupon" });
  }
});

// ================= CREATE COUPON =================
router.post("/", upload.single("image"), async (req, res) => {
  try {
    const validated = await validateCouponPayload(req.body);
    if (validated.error) {
      return res.status(400).json({ success: false, message: validated.error });
    }

    let imageUrl = null;
    if (req.file) {
      imageUrl = await uploadToCloudinary(req.file.buffer, req.file.originalname);
    }

    await pool.query(
      `INSERT INTO coupons
        (code, description, image, discount, quantity, category_id, type, buy_x, valid_from, valid_to, min_cart_amount, free_item, tiers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        validated.code,
        validated.description,
        imageUrl,
        validated.discountValue,
        null,
        null,
        validated.type,
        null,
        null,
        null,
        validated.minCartValue,
        validated.freeItemValue,
        validated.tiersValue,
      ]
    );

    res.json({ success: true, message: "Coupon created successfully" });
  } catch (err) {
    console.error("Superadmin Coupon Create Error:", err.message);
    res.status(500).json({ success: false, message: "Failed to create coupon" });
  }
});

// ================= UPDATE COUPON =================
router.put("/:id", upload.single("image"), async (req, res) => {
  try {
    const validated = await validateCouponPayload(req.body);
    if (validated.error) {
      return res.status(400).json({ success: false, message: validated.error });
    }

    let imageUrl = null;
    if (req.file) {
      imageUrl = await uploadToCloudinary(req.file.buffer, req.file.originalname);
    }

    await pool.query(
      `UPDATE coupons SET
        code=?, description=?, discount=?, quantity=?, category_id=?, type=?,
        buy_x=?, valid_from=?, valid_to=?, min_cart_amount=?, free_item=?, tiers=?,
        image=COALESCE(?, image)
       WHERE id=?`,
      [
        validated.code,
        validated.description,
        validated.discountValue,
        null,
        null,
        validated.type,
        null,
        null,
        null,
        validated.minCartValue,
        validated.freeItemValue,
        validated.tiersValue,
        imageUrl,
        req.params.id,
      ]
    );

    res.json({ success: true, message: "Coupon updated successfully" });
  } catch (err) {
    console.error("Superadmin Coupon Update Error:", err.message);
    res.status(500).json({ success: false, message: "Failed to update coupon" });
  }
});

// ================= DELETE COUPON =================
router.delete("/:id", async (req, res) => {
  try {
    const [result] = await pool.query("DELETE FROM coupons WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Coupon not found" });
    }
    res.json({ success: true, message: "Coupon deleted successfully" });
  } catch (err) {
    console.error("Superadmin Coupon Delete Error:", err.message);
    res.status(500).json({ success: false, message: "Failed to delete coupon" });
  }
});

module.exports = router;