const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateSuperadmin } = require("./superadmin");

const VALID_STATUSES = ["Pending", "Accepted", "Cooking", "Delivered", "Cancelled"];

function parseItems(itemsRaw) {
  try {
    const items = typeof itemsRaw === "string" ? JSON.parse(itemsRaw) : itemsRaw;
    if (!Array.isArray(items)) return [];
    return items.map(it => ({
      name: it.name,
      qty: Number(it.qty ?? it.quantity ?? 1),
      price: parseFloat(it.price) || 0,
      size: it.size || null,
      addons: Array.isArray(it.addons)
        ? it.addons.map(a => ({ name: a.name, price: parseFloat(a.price) || 0 }))
        : []
    }));
  } catch {
    return [];
  }
}

function itemCount(items) {
  return items.reduce((sum, it) => sum + (it.qty || 1), 0);
}

// Builds the friendly id superadmin sees: plain number for real orders,
// TEST01 / TEST02 ... for test orders (its own separate counter, so
// testing never creates gaps in the real order numbering).
function buildDisplayId(o) {
  return o.is_test
    ? `TEST${String(o.test_number).padStart(2, "0")}`
    : String(o.order_number);
}

// Every route below requires a valid superadmin session.
router.use(authenticateSuperadmin);

// ================== DISTINCT ORDER DATES (for the date dropdown) ==================
// GET /api/superadmin/orders/dates?includeTest=0
router.get("/dates", async (req, res) => {
  try {
    const includeTest = req.query.includeTest === "1";
    const [rows] = await pool.query(`
      SELECT DATE(created_at) AS order_date, COUNT(*) AS count
      FROM orders
      ${includeTest ? "" : "WHERE is_test = 0"}
      GROUP BY DATE(created_at)
      ORDER BY order_date DESC
      LIMIT 60
    `);

    const dates = rows.map(r => ({
      date: r.order_date instanceof Date
        ? r.order_date.toISOString().slice(0, 10)
        : String(r.order_date).slice(0, 10),
      count: r.count
    }));

    res.json({ success: true, dates });
  } catch (err) {
    console.error("Orders dates fetch error:", err);
    res.status(500).json({ success: false, message: "Failed to load order dates" });
  }
});

// ================== LIST ORDERS (with filters) ==================
// GET /api/superadmin/orders?status=&q=&date=YYYY-MM-DD&includeTest=0
router.get("/", async (req, res) => {
  try {
    const { status, q, date } = req.query;
    const includeTest = req.query.includeTest === "1";
    const where = [];
    const params = [];

    if (!includeTest) {
      where.push("is_test = 0");
    }
    if (status && VALID_STATUSES.includes(status)) {
      where.push("status = ?");
      params.push(status);
    }
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      where.push("DATE(created_at) = ?");
      params.push(date);
    }
    if (q && q.trim()) {
      const term = q.trim();
      // Support searching by "TEST5" / "test05" as well as a plain number
      // (matches order_number for real orders, test_number for test ones)
      // and still falls back to raw id / customer name.
      const testMatch = term.match(/^test0*(\d+)$/i);
      if (testMatch) {
        where.push("(is_test = 1 AND test_number = ?)");
        params.push(Number(testMatch[1]));
      } else if (/^\d+$/.test(term)) {
        where.push("(id = ? OR order_number = ?)");
        params.push(term, term);
      } else {
        where.push("customer_name LIKE ?");
        params.push(`%${term}%`);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT id, customer_name, table_number, session_id, items, coupon_code,
              subtotal, discount, total, instructions, status, is_test,
              order_number, test_number, created_at
       FROM orders ${whereSql} ORDER BY created_at DESC LIMIT 300`,
      params
    );

    res.json({
      success: true,
      orders: rows.map(o => {
        const items = parseItems(o.items);
        return {
          id: o.id,
          displayId: buildDisplayId(o),
          orderNumber: o.order_number,
          testNumber: o.test_number,
          customerName: o.customer_name,
          tableNumber: o.table_number,
          sessionId: o.session_id,
          items,
          itemCount: itemCount(items),
          couponCode: o.coupon_code,
          subtotal: parseFloat(o.subtotal),
          discount: parseFloat(o.discount),
          total: parseFloat(o.total),
          instructions: o.instructions || "",
          status: o.status,
          isTest: !!o.is_test,
          createdAt: o.created_at,
        };
      }),
    });
  } catch (err) {
    console.error("Orders fetch error:", err);
    res.status(500).json({ success: false, message: "Failed to load orders" });
  }
});

// ================== UPDATE ORDER STATUS ==================
// PUT /api/superadmin/orders/:id/status
router.put("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!VALID_STATUSES.includes(status)) {
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

    const [rows] = await pool.query(
      "SELECT session_id FROM orders WHERE id = ?",
      [id]
    );

    const io = req.app.get("io");
    if (io) {
      // Let the customer's own order-status page update live.
      if (rows[0]?.session_id) {
        io.to(`session:${rows[0].session_id}`).emit("orderStatusUpdated", {
          orderId: Number(id),
          status
        });
      }
      // Let any other open superadmin Orders tab stay in sync too.
      io.emit("superadmin-order-status-changed", {
        orderId: Number(id),
        status
      });
    }

    res.json({ success: true, message: `Order marked as ${status}` });
  } catch (err) {
    console.error("Superadmin update status error:", err);
    res.status(500).json({ success: false, message: "Failed to update order status" });
  }
});

module.exports = router;