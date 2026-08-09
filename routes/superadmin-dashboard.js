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

function pctDelta(today, yesterday) {
  if (!yesterday) return null;
  return Math.round(((today - yesterday) / yesterday) * 1000) / 10;
}

router.get("/stats", authenticateSuperadmin, async (req, res) => {
  try {
    const [[todayRow]] = await pool.query(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS rev
       FROM orders WHERE DATE(created_at) = CURDATE() AND status != 'Cancelled'`
    );
    const [[yesterdayRow]] = await pool.query(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS rev
       FROM orders WHERE DATE(created_at) = CURDATE() - INTERVAL 1 DAY AND status != 'Cancelled'`
    );

    const [[userTotalRow]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM users WHERE role = 'customer'`
    );
    const [[userTodayRow]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM users WHERE role = 'customer' AND DATE(created_at) = CURDATE()`
    );
    const [[userYesterdayRow]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM users WHERE role = 'customer' AND DATE(created_at) = CURDATE() - INTERVAL 1 DAY`
    );

    const [[couponRow]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM coupons WHERE type IN ('min_cart_amount','cart_tier')`
    );

    const [recentRows] = await pool.query(
      `SELECT id, customer_name, items, total, status, created_at
       FROM orders ORDER BY created_at DESC LIMIT 8`
    );

    res.json({
      success: true,
      ordersToday: todayRow.cnt,
      ordersDeltaPct: pctDelta(todayRow.cnt, yesterdayRow.cnt),
      revenueToday: parseFloat(todayRow.rev),
      revenueDeltaPct: pctDelta(parseFloat(todayRow.rev), parseFloat(yesterdayRow.rev)),
      totalUsers: userTotalRow.cnt,
      usersDeltaPct: pctDelta(userTodayRow.cnt, userYesterdayRow.cnt),
      activeCoupons: couponRow.cnt,
      couponsDeltaPct: null,
      recentOrders: recentRows.map(o => ({
        id: o.id,
        customerName: o.customer_name,
        itemCount: parseItemCount(o.items),
        total: parseFloat(o.total),
        status: o.status,
        createdAt: o.created_at,
      })),
    });
  } catch (err) {
    console.error("Dashboard stats error:", err);
    res.status(500).json({ success: false, message: "Failed to load stats" });
  }
});

module.exports = router;