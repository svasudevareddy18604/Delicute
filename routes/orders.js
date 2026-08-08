const express = require("express");
const router = express.Router();
const pool = require("../db"); // MySQL pool
const authenticate = require("../middleware/authenticate");
const { sendEmail } = require("../utils/email");

// ================== CREATE ORDER ==================
router.post("/", async (req, res) => {
  const { customer_name, table_number, items, coupon_code, subtotal, discount, total, instructions } = req.body;

  // Validate request
  if (!customer_name || !table_number || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }
  if (typeof subtotal !== "number" || typeof discount !== "number" || typeof total !== "number") {
    return res.status(400).json({ success: false, message: "Subtotal, discount, and total must be numbers" });
  }

  // Normalize items to ensure qty
  const normalizedItems = items.map(item => ({
    id: item.id,
    name: item.name,
    price: item.price,
    qty: item.qty || 1 // Fallback to 1 if qty is missing
  }));

  try {
    // Insert order into database
    const [result] = await pool.query(
      "INSERT INTO orders (customer_name, table_number, items, coupon_code, subtotal, discount, total, instructions, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', NOW())",
      [
        customer_name,
        table_number,
        JSON.stringify(normalizedItems),
        coupon_code || null,
        subtotal,
        discount || 0,
        total,
        instructions || ""
      ]
    );

    const orderId = result.insertId;

    // Fetch the created order for notifications
    const [orderRows] = await pool.query(
      "SELECT id, customer_name, table_number, items, coupon_code, subtotal, discount, total, instructions, status FROM orders WHERE id = ?",
      [orderId]
    );
    const order = {
      ...orderRows[0],
      items: typeof orderRows[0].items === "string" ? JSON.parse(orderRows[0].items) : orderRows[0].items,
      subtotal: parseFloat(orderRows[0].subtotal),
      discount: parseFloat(orderRows[0].discount),
      total: parseFloat(orderRows[0].total),
      instructions: orderRows[0].instructions || ""
    };
    console.log("Fetched order for notifications:", order); // Debug log

    // Send email notification via Brevo
    try {
      await sendEmail({
        to: "contactdelicute@gmail.com",
        subject: `New Order #${order.id} - DELICUTE`,
        html: `
          <h2>🍽️ New Order #${order.id}</h2>
          <p><b>Customer:</b> ${order.customer_name}</p>
          <p><b>Table:</b> ${order.table_number}</p>
          <p><b>Subtotal:</b> ₹${order.subtotal.toFixed(2)}</p>
          <p><b>Discount:</b> ₹${order.discount.toFixed(2)}</p>
          <p><b>Total:</b> ₹${order.total.toFixed(2)}</p>
          <p><b>Coupon:</b> ${order.coupon_code || "None"}</p>
          <h3>Items</h3>
          <ul>
            ${order.items
              .map(
                (item) =>
                  `<li>${item.name} × ${item.qty} - ₹${item.price.toFixed(2)}</li>`
              )
              .join("")}
          </ul>
          <p><b>Instructions:</b> ${order.instructions || "None"}</p>
        `,
      });

      console.log("✅ Brevo email sent");
    } catch (err) {
      console.error("❌ Brevo Error:", err);
      // Continue execution to avoid blocking response
    }

    // Emit WebSocket event
    const io = req.app.get("io");
    io.emit("new-order", {
      id: order.id,
      customer_name: order.customer_name,
      table_number: order.table_number,
      items: order.items,
      coupon_code: order.coupon_code,
      subtotal: order.subtotal,
      discount: order.discount,
      total: order.total,
      instructions: order.instructions,
      status: order.status
    });

    res.json({ success: true, orderId });
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ success: false, message: "Failed to create order" });
  }
});

// ================== GET ALL ORDERS ==================
router.get("/", authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT o.id, o.customer_name, o.table_number, o.items, o.coupon_code, 
             o.subtotal, o.discount, o.total, o.instructions, o.status, o.created_at
      FROM orders o
      ORDER BY o.created_at DESC
    `);

    // Parse items and normalize qty
    const orders = rows.map(order => {
      let items = order.items;
      if (typeof order.items === "string") {
        try {
          items = JSON.parse(order.items);
        } catch (err) {
          console.error(`Failed to parse items for order ${order.id}:`, order.items, err);
          items = [];
        }
      }
      items = Array.isArray(items)
        ? items.map(item => ({
            ...item,
            qty: item.qty ?? item.quantity ?? 1,
            price: parseFloat(item.price) // Ensure price is a number
          }))
        : [];
      return {
        ...order,
        items,
        subtotal: parseFloat(order.subtotal),
        discount: parseFloat(order.discount),
        total: parseFloat(order.total),
        instructions: order.instructions || ""
      };
    });

    res.json({ success: true, data: orders });
  } catch (err) {
    console.error("Get orders error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
});

// ================== CANCEL ORDER ==================
router.put("/:id/cancel", authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query(
      "UPDATE orders SET status = 'Cancelled' WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ success: false, message: "Order not found" });
    }

    res.json({ success: true, message: "Order cancelled successfully" });
  } catch (err) {
    console.error("Cancel order error:", err);
    res.status(500).json({ success: false, message: "Failed to cancel order" });
  }
});

// ================== DELETE ORDER ==================
router.delete("/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query("DELETE FROM orders WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    res.json({ success: true, message: "Order deleted successfully" });
  } catch (err) {
    console.error("Delete order error:", err);
    res.status(500).json({ success: false, message: "Failed to delete order" });
  }
});

// ================== UPDATE STATUS ==================
router.put("/:id/status", authenticate, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowed = ["Pending", "Accepted", "Cooking", "Delivered", "Cancelled"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ success: false, message: "Invalid status" });
  }

  try {
    const [result] = await pool.query(
      "UPDATE orders SET status = ? WHERE id = ?",
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    res.json({ success: true, message: `Order marked as ${status}` });
  } catch (err) {
    console.error("Update status error:", err);
    res.status(500).json({ success: false, message: "Failed to update status" });
  }
});

module.exports = router;