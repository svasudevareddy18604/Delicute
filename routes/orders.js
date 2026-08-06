const express = require("express");
const router = express.Router();
const pool = require("../db"); // MySQL pool
const authenticate = require("../middleware/authenticate");

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

    // Send email notification
    const transporter = req.app.get("transporter");
    const mailOptions = {
      from: `"DELICUTE Orders" <${process.env.EMAIL_USER}>`,
      to: "contactdelicute@gmail.com",
      subject: `New Order #${order.id} - DELICUTE`,
      text: `New order placed!\nOrder ID: ${order.id}\nCustomer: ${order.customer_name}\nTable: ${order.table_number}\nSubtotal: ₹${order.subtotal.toFixed(2)}\nDiscount: ₹${order.discount.toFixed(2)}\nTotal: ₹${order.total.toFixed(2)}\nCoupon: ${order.coupon_code || "None"}\nItems: ${order.items.map(item => `${item.name} (x${item.qty})`).join(", ")}\nInstructions: ${order.instructions || "None"}`,
      html: `
        <div style="font-family: 'Playfair Display', serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #e0f7fa, #b2ebf2); padding: 20px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
          <div style="text-align: center; padding-bottom: 20px;">
            <img src="https://i.postimg.cc/W3pgQx9q/DELICUTE-Imgur-1-modified.png" alt="DELICUTE Logo" style="height: 60px;">
            <h1 style="font-size: 2rem; color: #26a69aff; margin: 10px 0; text-shadow: 0 1px 3px rgba(0,0,0,0.1);">New Order #${order.id}</h1>
            <p style="font-size: 1rem; color: #1a1a1a;">Every Bite Tells A Story</p>
          </div>
          <div style="background: #fff; padding: 20px; border-radius: 8px;">
            <table style="width: 100%; border-collapse: collapse; font-size: 1rem; color: #1a1a1a;">
              <tr><td style="padding: 8px; font-weight: 600;">Customer:</td><td style="padding: 8px;">${order.customer_name}</td></tr>
              <tr><td style="padding: 8px; font-weight: 600;">Table:</td><td style="padding: 8px;">${order.table_number}</td></tr>
              <tr><td style="padding: 8px; font-weight: 600;">Subtotal:</td><td style="padding: 8px;">₹${order.subtotal.toFixed(2)}</td></tr>
              <tr><td style="padding: 8px; font-weight: 600;">Discount:</td><td style="padding: 8px;">₹${order.discount.toFixed(2)}</td></tr>
              <tr><td style="padding: 8px; font-weight: 600;">Total:</td><td style="padding: 8px;">₹${order.total.toFixed(2)}</td></tr>
              <tr><td style="padding: 8px; font-weight: 600;">Coupon:</td><td style="padding: 8px;">${order.coupon_code || "None"}</td></tr>
              <tr><td style="padding: 8px; font-weight: 600;">Items:</td><td style="padding: 8px;">
                <ul style="margin: 0; padding-left: 20px;">
                  ${order.items.map(item => `<li>${item.name} (x${item.qty}) - ₹${item.price.toFixed(2)}</li>`).join("")}
                </ul>
              </td></tr>
              <tr><td style="padding: 8px; font-weight: 600;">Instructions:</td><td style="padding: 8px;">${order.instructions || "None"}</td></tr>
            </table>
          </div>
          <div style="text-align: center; padding-top: 20px; font-size: 0.9rem; color: #4b5e8e;">
            <p>DELICUTE &copy; ${new Date().getFullYear()} | All Rights Reserved</p>
          </div>
        </div>
      `
    };
    try {
      await transporter.sendMail(mailOptions);
      console.log(`Email sent for order #${order.id} to ${mailOptions.to}`);
    } catch (emailErr) {
      console.error(`Failed to send email for order #${order.id}:`, emailErr);
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

// ================== TEST EMAIL ENDPOINT ==================
router.get("/test-email", authenticate, async (req, res) => {
  try {
    const transporter = req.app.get("transporter");
    const mailOptions = {
      from: `"DELICUTE Test" <${process.env.EMAIL_USER}>`,
      to: "contactdelicute@gmail.com",
      subject: "Test Email from DELICUTE",
      text: "This is a test email to verify Nodemailer configuration.",
      html: `
        <div style="font-family: 'Roboto', sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #e0f7fa, #b2ebf2); padding: 15px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <div style="text-align: center; padding-bottom: 15px;">
            <img src="https://i.postimg.cc/W3pgQx9q/DELICUTE-Imgur-1-modified.png" alt="DELICUTE Logo" style="height: 50px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));">
            <h1 style="font-family: 'Playfair Display', serif; font-size: 24px; color: #26a69a; margin: 10px 0 5px; font-weight: 700;">Test Email</h1>
          </div>
          <div style="background: #fff; padding: 15px; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,0.05);">
            <p style="font-size: 14px; color: #1a1a1a; line-height: 1.5; margin: 0;">This is a test email to verify Nodemailer configuration.</p>
          </div>
          <div style="text-align: center; padding-top: 15px; font-size: 12px; color: #4b5e8e;">
            <p style="margin: 0;">DELICUTE &copy; ${new Date().getFullYear()} | All Rights Reserved</p>
          </div>
        </div>
      `
    };
    await transporter.sendMail(mailOptions);
    console.log("Test email sent successfully to contactdelicute@gmail.com");
    res.json({ success: true, message: "Test email sent successfully" });
  } catch (err) {
    console.error("Test email error:", err);
    res.status(500).json({ success: false, message: "Failed to send test email", error: err.message });
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

  const allowed = ["Pending", "Preparing", "Delivered", "Cancelled"];
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