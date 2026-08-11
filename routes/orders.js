const express = require("express");
const router = express.Router();
const pool = require("../db"); // MySQL pool
const authenticate = require("../middleware/authenticate");
const { sendEmail } = require("../utils/email");

// ================== CREATE ORDER ==================
router.post("/", async (req, res) => {
  const { customer_name, table_number, session_id, items, coupon_code, subtotal, discount, total, instructions, test_mode } = req.body;

  // Validate request
  if (!customer_name || !table_number || !session_id || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }
  if (typeof subtotal !== "number" || typeof discount !== "number" || typeof total !== "number") {
    return res.status(400).json({ success: false, message: "Subtotal, discount, and total must be numbers" });
  }

  const isTest = test_mode === true ? 1 : 0;

  // Normalize items to ensure qty, and PRESERVE size + addons.
  // Previously this mapping dropped `size` and `addons` entirely, so even
  // though the customer's cart correctly sent them in the request body,
  // they never made it into the JSON that gets saved to the orders table —
  // meaning admin had no way to see what add-ons were selected.
  const normalizedItems = items.map(item => ({
    id: item.id,
    name: item.name,
    price: item.price,
    qty: item.qty || 1, // Fallback to 1 if qty is missing
    size: item.size || null,
    addons: Array.isArray(item.addons) ? item.addons.map(a => ({
      addon_id: a.addon_id,
      name: a.name,
      price: a.price
    })) : []
  }));

  try {
    // Insert order into database
    const [result] = await pool.query(
      "INSERT INTO orders (customer_name, table_number, session_id, items, coupon_code, subtotal, discount, total, instructions, status, is_test, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, NOW())",
      [
        customer_name,
        table_number,
        session_id,
        JSON.stringify(normalizedItems),
        coupon_code || null,
        subtotal,
        discount || 0,
        total,
        instructions || "",
        isTest
      ]
    );

    const orderId = result.insertId;

    // Fetch the created order for notifications
    const [orderRows] = await pool.query(
      "SELECT id, customer_name, table_number, session_id, items, coupon_code, subtotal, discount, total, instructions, status, is_test, created_at FROM orders WHERE id = ?",
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
    console.log(`Fetched order for notifications (test=${!!order.is_test}):`, order); // Debug log

    // Skip email + admin broadcast entirely for test orders — real staff
    // never see or get emailed about anything created in test mode.
    if (!isTest) {
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
                    `<li>${item.name}${item.size ? ` (${item.size})` : ""} × ${item.qty} - ₹${item.price.toFixed(2)}${
                      Array.isArray(item.addons) && item.addons.length
                        ? `<br/><small>+ ${item.addons.map(a => `${a.name} (₹${Number(a.price).toFixed(2)})`).join(", ")}</small>`
                        : ""
                    }</li>`
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

      // Emit WebSocket event — cafe/admin dashboard listens for "new-order" globally.
      // Not emitted at all for test orders, so the kitchen/admin screen never
      // flickers or shows a test order.
      const io = req.app.get("io");
      io.emit("new-order", {
        id: order.id,
        customer_name: order.customer_name,
        table_number: order.table_number,
        session_id: order.session_id,
        items: order.items,
        coupon_code: order.coupon_code,
        subtotal: order.subtotal,
        discount: order.discount,
        total: order.total,
        instructions: order.instructions,
        status: order.status
      });
    } else {
      console.log(`🧪 Test order #${order.id} created — email and admin broadcast skipped`);
    }

    // Always emit to the customer's own session room (test or not) so the
    // person testing can still see their own order-status page update live.
    const io = req.app.get("io");
    io.to(`session:${order.session_id}`).emit("orderStatusUpdated", {
      orderId: order.id,
      status: order.status
    });

    res.json({ success: true, orderId, is_test: !!isTest });
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ success: false, message: "Failed to create order" });
  }
});

// ================== GET ALL ORDERS (admin/cafe dashboard) ==================
// Real staff only ever see real orders. Pass ?includeTest=1 explicitly
// (e.g. from a hidden dev-only view) if you ever want to see test orders here too.
router.get("/", authenticate, async (req, res) => {
  const includeTest = req.query.includeTest === "1";
  try {
    const [rows] = await pool.query(`
      SELECT o.id, o.customer_name, o.table_number, o.session_id, o.items, o.coupon_code, 
             o.subtotal, o.discount, o.total, o.instructions, o.status, o.is_test, o.created_at
      FROM orders o
      ${includeTest ? "" : "WHERE o.is_test = 0"}
      ORDER BY o.created_at DESC
    `);

    // Parse items and normalize qty/size/addons
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
            price: parseFloat(item.price), // Ensure price is a number
            size: item.size || null,
            addons: Array.isArray(item.addons)
              ? item.addons.map(a => ({
                  addon_id: a.addon_id,
                  name: a.name,
                  price: parseFloat(a.price) || 0
                }))
              : []
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

// ================== GET ORDERS FOR A CUSTOMER SESSION (public, no auth) ==================
// Used by the order-status page to look up the customer's own order(s),
// including after they've closed and reopened the tab. Includes test
// orders too — this route is only ever reachable by someone who already
// has that exact session_id, i.e. the person who placed the order.
router.get("/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId) {
    return res.status(400).json({ success: false, message: "Missing session id" });
  }

  try {
    const [rows] = await pool.query(
      `SELECT id, customer_name, table_number, session_id, items, coupon_code,
              subtotal, discount, total, instructions, status, is_test, created_at
       FROM orders
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 5`,
      [sessionId]
    );

    const orders = rows.map(order => {
      let items = order.items;
      if (typeof items === "string") {
        try { items = JSON.parse(items); } catch { items = []; }
      }
      items = Array.isArray(items)
        ? items.map(item => ({
            ...item,
            qty: item.qty ?? item.quantity ?? 1,
            price: parseFloat(item.price),
            size: item.size || null,
            addons: Array.isArray(item.addons)
              ? item.addons.map(a => ({
                  addon_id: a.addon_id,
                  name: a.name,
                  price: parseFloat(a.price) || 0
                }))
              : []
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
    console.error("Get session orders error:", err);
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

    const [rows] = await pool.query("SELECT session_id FROM orders WHERE id = ?", [id]);
    if (rows[0]?.session_id) {
      const io = req.app.get("io");
      io.to(`session:${rows[0].session_id}`).emit("orderStatusUpdated", {
        orderId: Number(id),
        status: "Cancelled"
      });
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

    const [rows] = await pool.query("SELECT session_id FROM orders WHERE id = ?", [id]);
    if (rows[0]?.session_id) {
      const io = req.app.get("io");
      io.to(`session:${rows[0].session_id}`).emit("orderStatusUpdated", {
        orderId: Number(id),
        status
      });
    }

    res.json({ success: true, message: `Order marked as ${status}` });
  } catch (err) {
    console.error("Update status error:", err);
    res.status(500).json({ success: false, message: "Failed to update status" });
  }
});

module.exports = router;