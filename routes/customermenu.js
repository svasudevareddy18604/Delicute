const express = require("express");
const router = express.Router();
const pool = require("../db"); // centralized pool import

///////////////////////////
// GET Menu Items
///////////////////////////
router.get("/menu", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT m.id, m.name, m.price, m.description, m.image, 
             m.saved_price, m.is_top_pick, m.size, c.name AS category
      FROM menu_items m
      JOIN categories c ON m.category_id = c.id
      ORDER BY c.name, m.name, m.size
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Menu Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch menu" });
  }
});

///////////////////////////
// GET Active Coupons
///////////////////////////
router.get("/coupons", async (req, res) => {
  try {
    const now = new Date();
    const [rows] = await pool.query(
      `
      SELECT c.id, c.code, c.description, c.image, c.discount, c.quantity, c.type, c.buy_x, 
             c.valid_from, c.valid_to, c.min_cart_amount, cat.name AS category
      FROM coupons c
      LEFT JOIN categories cat ON c.category_id = cat.id
      WHERE (c.valid_from IS NULL OR c.valid_from <= ?) 
        AND (c.valid_to IS NULL OR c.valid_to >= ?)
        AND (c.quantity > 0 OR c.quantity IS NULL)
    `,
      [now, now]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Coupon Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch coupons" });
  }
});

///////////////////////////
// POST New Order
///////////////////////////
router.post("/orders", async (req, res) => {
  let conn;
  try {
    const { customer_name, table_number, items, coupon_code } = req.body;

    if (!customer_name || !table_number || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid order data" });
    }

    let subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    let discount = 0;
    let total = subtotal;

    // ====== Apply Coupon Logic (flexible for all scenarios) ======
    if (coupon_code) {
      const [cRows] = await pool.query(
        `SELECT c.*, cat.id AS category_id, cat.name AS category_name 
         FROM coupons c 
         LEFT JOIN categories cat ON c.category_id = cat.id
         WHERE c.code = ? 
           AND (c.valid_from IS NULL OR c.valid_from <= NOW()) 
           AND (c.valid_to IS NULL OR c.valid_to >= NOW())
           AND (c.quantity > 0 OR c.quantity IS NULL)
         LIMIT 1`,
        [coupon_code]
      );

      if (cRows.length === 0) {
        return res.status(400).json({ success: false, message: "Invalid or expired coupon" });
      }

      const coupon = cRows[0];
      let eligibleSubtotal = subtotal;
      let eligibleQty = items.reduce((sum, i) => sum + i.qty, 0);

      // Handle min_cart_amount coupon
      if (coupon.type === "min_cart_amount") {
        if (subtotal < (coupon.min_cart_amount || 0)) {
          return res.status(400).json({
            success: false,
            message: `Coupon requires a minimum cart amount of ₹${coupon.min_cart_amount} (current: ₹${subtotal.toFixed(2)})`,
          });
        }
        discount = (subtotal * coupon.discount) / 100;
      }
      // Handle category-specific coupons
      else {
        if (!coupon.category_id) {
          return res.status(400).json({
            success: false,
            message: "Coupon is invalid: no category specified",
          });
        }

        const [catItems] = await pool.query(
          `SELECT id FROM menu_items WHERE category_id = ?`,
          [coupon.category_id]
        );
        const catIds = catItems.map(i => i.id);
        const eligibleItems = items.filter(i => catIds.includes(i.id));
        eligibleSubtotal = eligibleItems.reduce((sum, i) => sum + i.price * i.qty, 0);
        eligibleQty = eligibleItems.reduce((sum, i) => sum + i.qty, 0);

        if (eligibleSubtotal === 0) {
          return res.status(400).json({
            success: false,
            message: `Coupon is only valid for ${coupon.category_name} items`,
          });
        }

        if (coupon.type === "buy_x") {
          if (eligibleQty >= (coupon.buy_x || 0)) {
            discount = (eligibleSubtotal * coupon.discount) / 100;
          }
        } else if (coupon.type === "percentage") {
          discount = (eligibleSubtotal * coupon.discount) / 100;
        } else if (coupon.type === "fixed") {
          discount = Math.min(coupon.discount, eligibleSubtotal);
        } else if (coupon.type === "bogo") {
          if (eligibleQty >= 2) {
            const pairs = Math.floor(eligibleQty / 2);
            const avgPrice = eligibleSubtotal / eligibleQty;
            discount = pairs * avgPrice;
          }
        }
      }

      // Update coupon quantity if applicable
      if (coupon.quantity !== null) {
        await pool.query(`UPDATE coupons SET quantity = quantity - 1 WHERE id = ?`, [coupon.id]);
      }
    }

    total = subtotal - discount;
    if (total < 0) total = 0;

    // ====== Save order in DB ======
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [orderResult] = await conn.query(
      `INSERT INTO orders 
         (customer_name, table_number, items, coupon_code, subtotal, discount, total, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'Pending')`,
      [
        customer_name,
        table_number,
        JSON.stringify(items),
        coupon_code || null,
        subtotal,
        discount,
        total,
      ]
    );

    const orderId = orderResult.insertId;

    // order_items table
    const values = items.map(i => [
      orderId,
      i.id,
      i.qty,
      i.price,
      i.price * i.qty,
    ]);
    await conn.query(
      `INSERT INTO order_items (order_id, menu_item_id, quantity, price_at_order, line_total)
       VALUES ?`,
      [values]
    );

    await conn.commit();
    res.json({ success: true, orderId, subtotal, discount, total });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("Order Placement Error:", err);
    res.status(500).json({ success: false, message: "Failed to place order", error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;