const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateSuperadmin } = require("./superadmin");

function parseItemCount(itemsRaw) {
  try {
    const items = typeof itemsRaw === "string" ? JSON.parse(itemsRaw) : itemsRaw;
    if (!Array.isArray(items)) return 0;
    return items.reduce((sum, it) => sum + (Number(it.qty ?? it.quantity ?? 1)), 0);
  } catch {
    return 0;
  }
}

const VALID_STATUSES = ["Pending", "Accepted", "Cooking", "Delivered", "Cancelled"];

router.get("/", authenticateSuperadmin, async (req, res) => {
  try {
    const { status, q } = req.query;
    const where = [];
    const params = [];

    if (status && VALID_STATUSES.includes(status)) {
      where.push("status = ?");
      params.push(status);
    }
    if (q && q.trim()) {
      const term = q.trim();
      if (/^\d+$/.test(term)) {
        where.push("id = ?");
        params.push(term);
      } else {
        where.push("customer_name LIKE ?");
        params.push(`%${term}%`);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT id, customer_name, table_number, items, total, status, created_at
       FROM orders ${whereSql} ORDER BY created_at DESC LIMIT 200`,
      params
    );

    res.json({
      success: true,
      orders: rows.map(o => ({
        id: o.id,
        customerName: o.customer_name,
        tableNumber: o.table_number,
        itemCount: parseItemCount(o.items),
        total: parseFloat(o.total),
        status: o.status,
        createdAt: o.created_at,
      })),
    });
  } catch (err) {
    console.error("Orders fetch error:", err);
    res.status(500).json({ success: false, message: "Failed to load orders" });
  }
});

module.exports = router;