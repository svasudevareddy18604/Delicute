const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateSuperadmin } = require("./superadmin");

router.use(authenticateSuperadmin);

function parseItemsSafe(raw) {
  try {
    const items = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

// ================== DASHBOARD STATS ==================
// GET /api/superadmin/dashboard/stats
router.get("/stats", async (req, res) => {
  try {
    // ---------- Today / Week / Month / All-time revenue + order counts ----------
    // Real orders only (is_test = 0) everywhere revenue/order counts are shown.
    const [[todayRow]] = await pool.query(`
      SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue
      FROM orders WHERE is_test = 0 AND DATE(created_at) = CURDATE()
    `);
    const [[yesterdayRow]] = await pool.query(`
      SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue
      FROM orders WHERE is_test = 0 AND DATE(created_at) = CURDATE() - INTERVAL 1 DAY
    `);
    const [[weekRow]] = await pool.query(`
      SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue
      FROM orders WHERE is_test = 0 AND created_at >= CURDATE() - INTERVAL 6 DAY
    `);
    const [[monthRow]] = await pool.query(`
      SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue
      FROM orders WHERE is_test = 0 AND YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())
    `);
    const [[allTimeRow]] = await pool.query(`
      SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue
      FROM orders WHERE is_test = 0
    `);
    const [[testTodayRow]] = await pool.query(`
      SELECT COUNT(*) AS orders
      FROM orders WHERE is_test = 1 AND DATE(created_at) = CURDATE()
    `);

    const ordersDeltaPct = yesterdayRow.orders > 0
      ? Math.round(((todayRow.orders - yesterdayRow.orders) / yesterdayRow.orders) * 100)
      : (todayRow.orders > 0 ? 100 : 0);
    const revenueDeltaPct = yesterdayRow.revenue > 0
      ? Math.round(((todayRow.revenue - yesterdayRow.revenue) / yesterdayRow.revenue) * 100)
      : (todayRow.revenue > 0 ? 100 : 0);

    // ---------- Revenue trend — last 7 days (filled for missing days) ----------
    const [trendRows] = await pool.query(`
      SELECT DATE(created_at) AS day, COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue
      FROM orders
      WHERE is_test = 0 AND created_at >= CURDATE() - INTERVAL 6 DAY
      GROUP BY DATE(created_at)
      ORDER BY day ASC
    `);
    const trendMap = new Map(
      trendRows.map(r => [
        (r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10)),
        { orders: r.orders, revenue: parseFloat(r.revenue) }
      ])
    );
    const revenueTrend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const entry = trendMap.get(key) || { orders: 0, revenue: 0 };
      revenueTrend.push({ date: key, ...entry });
    }

    // ---------- Today's status breakdown ----------
    const [statusRows] = await pool.query(`
      SELECT status, COUNT(*) AS count
      FROM orders WHERE is_test = 0 AND DATE(created_at) = CURDATE()
      GROUP BY status
    `);
    const statusBreakdown = { Pending: 0, Accepted: 0, Cooking: 0, Delivered: 0, Cancelled: 0 };
    statusRows.forEach(r => { statusBreakdown[r.status] = r.count; });

    // ---------- Peak hours — last 30 days ----------
    const [hourRows] = await pool.query(`
      SELECT HOUR(created_at) AS hr, COUNT(*) AS count
      FROM orders
      WHERE is_test = 0 AND created_at >= CURDATE() - INTERVAL 30 DAY
      GROUP BY HOUR(created_at)
    `);
    const hourMap = new Map(hourRows.map(r => [r.hr, r.count]));
    const peakHours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourMap.get(h) || 0 }));

    // ---------- Top-selling items — last 30 days ----------
    const [itemRows] = await pool.query(`
      SELECT items FROM orders
      WHERE is_test = 0 AND created_at >= CURDATE() - INTERVAL 30 DAY
    `);
    const itemTally = new Map();
    itemRows.forEach(row => {
      parseItemsSafe(row.items).forEach(it => {
        const key = it.name || "Unknown item";
        const qty = Number(it.qty ?? it.quantity ?? 1);
        const revenue = (Number(it.price) || 0) * qty;
        const prev = itemTally.get(key) || { name: key, qty: 0, revenue: 0 };
        prev.qty += qty;
        prev.revenue += revenue;
        itemTally.set(key, prev);
      });
    });
    const topItems = [...itemTally.values()].sort((a, b) => b.qty - a.qty).slice(0, 6);

    // ---------- Coupon performance ----------
    const [[couponAgg]] = await pool.query(`
      SELECT COUNT(*) AS uses, COALESCE(SUM(discount),0) AS totalDiscount
      FROM orders WHERE is_test = 0 AND coupon_code IS NOT NULL
    `);
    const [couponTop] = await pool.query(`
      SELECT coupon_code, COUNT(*) AS uses, COALESCE(SUM(discount),0) AS totalDiscount
      FROM orders
      WHERE is_test = 0 AND coupon_code IS NOT NULL
      GROUP BY coupon_code
      ORDER BY uses DESC
      LIMIT 5
    `);
    const [[couponCountRow]] = await pool.query(`SELECT COUNT(*) AS total FROM coupons`);

    // ---------- Average order value ----------
    const avgOrderValueToday = todayRow.orders > 0 ? todayRow.revenue / todayRow.orders : 0;
    const avgOrderValueAllTime = allTimeRow.orders > 0 ? allTimeRow.revenue / allTimeRow.orders : 0;

    res.json({
      success: true,
      ordersToday: todayRow.orders,
      revenueToday: parseFloat(todayRow.revenue),
      ordersDeltaPct,
      revenueDeltaPct,

      ordersWeek: weekRow.orders,
      revenueWeek: parseFloat(weekRow.revenue),

      ordersMonth: monthRow.orders,
      revenueMonth: parseFloat(monthRow.revenue),

      ordersAllTime: allTimeRow.orders,
      revenueAllTime: parseFloat(allTimeRow.revenue),

      testOrdersToday: testTodayRow.orders,

      avgOrderValueToday,
      avgOrderValueAllTime,

      activeCoupons: couponCountRow.total,

      revenueTrend,
      statusBreakdown,
      peakHours,
      topItems,

      couponStats: {
        totalUses: couponAgg.uses,
        totalDiscountGiven: parseFloat(couponAgg.totalDiscount),
        topCoupons: couponTop.map(c => ({
          code: c.coupon_code,
          uses: c.uses,
          totalDiscount: parseFloat(c.totalDiscount)
        }))
      }
    });
  } catch (err) {
    console.error("Dashboard stats error:", err);
    res.status(500).json({ success: false, message: "Failed to load dashboard stats" });
  }
});

module.exports = router;