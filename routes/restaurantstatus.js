const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { getStatusRow, evaluate, localNow } = require("../utils/restaurantStatus");

const router = express.Router();

///////////////////////////
// Admin auth
// NOTE: written to read a JWT from the "token" cookie (or Bearer header).
// If your admin routes already use a middleware, replace this with it.
///////////////////////////
function requireAdmin(req, res, next) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = (req.cookies && req.cookies.token) || bearer;
  if (!token) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Session expired. Please log in again." });
  }
}

///////////////////////////
// Helpers
///////////////////////////
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isRealDate = (s) => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};

/* Shape sent to the admin page, dashboard and customers */
function buildPayload(s) {
  const e = evaluate(s);
  return {
    is_open: s.is_open,
    opening_time: s.opening_time,
    closing_time: s.closing_time,
    closure_from: s.closure_from,
    closure_to: s.closure_to,
    closed_message: s.closed_message || "",
    accepting_orders: e.accepting,
    reason: e.reason,
    reopens_on: e.reopens_on,
    updated_at: s.updated_at,
  };
}

///////////////////////////
// GET /api/restaurant-status  (public)
///////////////////////////
router.get("/", async (req, res) => {
  try {
    const status = await getStatusRow();
    res.set("Cache-Control", "no-store");
    res.json({ success: true, data: buildPayload(status) });
  } catch (err) {
    console.error("Restaurant Status Fetch Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch restaurant status" });
  }
});

///////////////////////////
// PUT /api/restaurant-status  (admin only)
///////////////////////////
router.put("/", requireAdmin, async (req, res) => {
  try {
    const { is_open, opening_time, closing_time, closure_from, closure_to, closed_message } = req.body || {};

    // ---- Validation ----
    if (typeof is_open !== "boolean") {
      return res.status(400).json({ success: false, message: "is_open must be true or false" });
    }

    const hasHours = opening_time != null || closing_time != null;
    if (hasHours) {
      if (!TIME_RE.test(opening_time || "") || !TIME_RE.test(closing_time || "")) {
        return res.status(400).json({ success: false, message: "Opening and closing time must both be valid (HH:MM)" });
      }
      if (opening_time === closing_time) {
        return res.status(400).json({ success: false, message: "Opening and closing time can't be the same" });
      }
    }

    const hasClosure = closure_from != null || closure_to != null;
    if (hasClosure) {
      if (!isRealDate(closure_from || "") || !isRealDate(closure_to || "")) {
        return res.status(400).json({ success: false, message: "Both closed dates must be valid" });
      }
      if (closure_to < closure_from) {
        return res.status(400).json({ success: false, message: "The 'To' date must be on or after 'From'" });
      }
      if (closure_to < localNow().date) {
        return res.status(400).json({ success: false, message: "Closed dates are already in the past" });
      }
    }

    const message = typeof closed_message === "string" ? closed_message.trim() : "";
    if (message.length > 140) {
      return res.status(400).json({ success: false, message: "Message must be 140 characters or less" });
    }

    const updatedBy = String(
      (req.user && (req.user.name || req.user.email || req.user.username || req.user.id)) || "admin"
    ).slice(0, 100);

    // ---- Save (creates the row if it's missing) ----
    await pool.query(
      `INSERT INTO restaurant_status
         (id, is_open, opening_time, closing_time, closure_from, closure_to, closed_message, updated_by)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         is_open        = VALUES(is_open),
         opening_time   = VALUES(opening_time),
         closing_time   = VALUES(closing_time),
         closure_from   = VALUES(closure_from),
         closure_to     = VALUES(closure_to),
         closed_message = VALUES(closed_message),
         updated_by     = VALUES(updated_by)`,
      [
        is_open ? 1 : 0,
        hasHours ? opening_time : null,
        hasHours ? closing_time : null,
        hasClosure ? closure_from : null,
        hasClosure ? closure_to : null,
        message,
        updatedBy,
      ]
    );

    const status = await getStatusRow();
    const data = buildPayload(status);

    console.log(
      `[RESTAURANT STATUS] ${updatedBy} set is_open=${data.is_open} hours=${data.opening_time || "-"}-${data.closing_time || "-"} closed=${data.closure_from || "-"}..${data.closure_to || "-"}`
    );

    // Live update for open dashboards (and any customer page that listens)
    const io = req.app.get("io");
    if (io) io.emit("restaurant-status-changed", data);

    res.json({ success: true, message: "Status updated", data });
  } catch (err) {
    console.error("Restaurant Status Update Error:", err);
    res.status(500).json({ success: false, message: "Failed to update restaurant status" });
  }
});

module.exports = router;