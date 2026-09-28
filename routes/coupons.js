const express = require("express");
const router = express.Router();
const pool = require("../db");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { Readable } = require("stream");

// ================= CLOUDINARY CONFIG =================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ================= MULTER (for file upload) =================
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Helper → upload buffer to Cloudinary
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

// Coupon types the SCHEMA still supports (buy_x / date_range / bogo rows can
// still exist and will still be returned by GET) — the admin UI currently
// creates two types: "min_cart_amount" (storewide flat %) and "cart_tier"
// (cart-value tiers, e.g. ₹1000+ → 25%, ₹2000+ → 50%).
// See the PARKED block at the bottom to re-enable buy_x / date_range / bogo.
const VALID_COUPON_TYPES = ["buy_x", "date_range", "min_cart_amount", "bogo", "cart_tier"];
const ACTIVE_TYPES = ["min_cart_amount", "cart_tier"];

// Tier shape check: [{ amount: number >= 0, discount: number 0-100 }, ...]
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

  // Sort ascending by amount — validate-coupon logic picks the highest
  // qualifying tier, so a consistent order matters for that lookup.
  cleaned.sort((a, b) => a.amount - b.amount);

  return { tiers: cleaned };
}

// ================= SHARED VALIDATION =================
// Returns { error } on failure, or the clean values to insert/update.
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

  // ---- TYPE: cart_tier ----
  if (resolvedType === "cart_tier") {
    const tierResult = validateTiers(tiers);
    if (tierResult.error) return { error: tierResult.error };

    return {
      code,
      description,
      type: "cart_tier",
      discountValue: 0,   // discount column is NOT NULL — cart_tier coupons
                           // store their real percentages in `tiers` instead
      minCartValue: null,
      freeItemValue: null,
      tiersValue: JSON.stringify(tierResult.tiers),
    };
  }

  // ---- TYPE: min_cart_amount (storewide flat %) ----
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
    // If a free_item is also set, discount is forced to 0 (free_item wins).
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
    console.error("Coupons Fetch Error:", err.message);
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
    console.error("Fetch One Coupon Error:", err.message);
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
        null,             // quantity — not used by either active type
        null,             // category_id — null = applies to ALL categories
        validated.type,
        null,             // buy_x — not used
        null,             // valid_from — not used
        null,             // valid_to — not used
        validated.minCartValue,
        validated.freeItemValue,
        validated.tiersValue,
      ]
    );

    res.json({ success: true, message: "Coupon created successfully" });
  } catch (err) {
    console.error("Coupon Create Error:", err.message);
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
    console.error("Coupon Update Error:", err.message);
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
    console.error("Coupon Delete Error:", err.message);
    res.status(500).json({ success: false, message: "Failed to delete coupon" });
  }
});

module.exports = router;

/* ====================================================================
   PARKED FOR LATER — full buy_x / date_range / bogo / per-category
   validation, exactly as it was before the storewide-only simplification.
   To restore: merge this back into validateCouponPayload() above, add
   the type to ACTIVE_TYPES, and restore quantity/category_id/buy_x/
   valid_from/valid_to in the INSERT/UPDATE param arrays (pull the values
   from validateCouponPayload's return instead of hardcoding null).

async function validateCouponPayload_FULL(body) {
  const {
    code, description, discount, quantity, category, type,
    buy_x, valid_from, valid_to, min_cart_amount, free_item,
  } = body;

  if (!code || !description || !type) {
    return { error: "Code, description, and type are required" };
  }
  if (!VALID_COUPON_TYPES.includes(type)) {
    return { error: "Invalid coupon type" };
  }

  if (discount != null && discount !== "") {
    const d = Number(discount);
    if (!Number.isFinite(d) || d < 0 || d > 100) {
      return { error: "Discount must be a number between 0 and 100" };
    }
  }

  if (type === "min_cart_amount") {
    if (min_cart_amount != null && min_cart_amount !== "") {
      const m = Number(min_cart_amount);
      if (!Number.isFinite(m) || m < 0) {
        return { error: "Minimum cart amount must be a non-negative number" };
      }
    }
    if ((discount == null || discount === "") && !free_item) {
      return { error: "Discount or free item is required for Min Cart Amount type" };
    }
  } else {
    if (quantity == null || quantity === "") {
      return { error: "Quantity is required for this coupon type" };
    }
    const q = Number(quantity);
    if (!Number.isInteger(q) || q < 1) {
      return { error: "Quantity must be a positive integer" };
    }
    if (type !== "bogo" && (discount == null || discount === "")) {
      return { error: "Discount is required for this coupon type" };
    }
  }

  if (type === "buy_x") {
    const bx = Number(buy_x);
    if (!Number.isInteger(bx) || bx < 1) {
      return { error: "Buy X quantity must be a positive integer for Buy X type" };
    }
  }

  if (type === "date_range") {
    if (!valid_from || !valid_to) {
      return { error: "Valid from and valid to dates are required for Date Range type" };
    }
    if (new Date(valid_from) > new Date(valid_to)) {
      return { error: "Valid from date must be before valid to date" };
    }
  }

  let category_id = null;
  if (type !== "min_cart_amount") {
    if (!category) {
      return { error: "Category is required for this coupon type" };
    }
    const [catRows] = await pool.query("SELECT id FROM categories WHERE name = ?", [category]);
    if (catRows.length === 0) {
      return { error: "Invalid category" };
    }
    category_id = catRows[0].id;
  }

  const discountValue =
    type === "bogo" || (type === "min_cart_amount" && free_item)
      ? 0
      : discount != null && discount !== "" ? Number(discount) : null;

  return {
    code, description, discountValue,
    quantity: quantity || null,
    category_id, type,
    buy_x: type === "buy_x" ? Number(buy_x) : null,
    valid_from: type === "date_range" ? valid_from : null,
    valid_to: type === "date_range" ? valid_to : null,
    min_cart_amount: type === "min_cart_amount" && min_cart_amount != null && min_cart_amount !== ""
      ? Number(min_cart_amount) : null,
    free_item: type === "min_cart_amount" ? free_item || null : null,
  };
}
==================================================================== */