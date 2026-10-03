const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { MODES, getStatusRow, evaluateMode, localNow } = require("../utils/restaurantStatus");

const router = express.Router();

///////////////////////////
// Admin auth
// NOTE: reads a JWT from the "token" cookie (or Bearer header).
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
const LABEL = { dine_in: "Dine In", dine_out: "Dine Out" };

const isRealDate = (s) => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};

/* Shape sent to the admin page, dashboard and customers */
function buildPayload(s) {
  const now = localNow();
  const payload = { updated_at: s.updated_at };
  for (const m of MODES) {
    const e = evaluateMode(s[m], now);
    payload[m] = {
      is_open: s[m].is_open,
      opening_time: s[m].opening_time,
      closing_time: s[m].closing_time,
      closure_from: s[m].closure_from,
      closure_to: s[m].closure_to,
      closed_message: s[m].closed_message || "",
      accepting_orders: e.accepting,
      reason: e.reason,
      reopens_on: e.reopens_on,
    };
  }
  payload.accepting_orders = MODES.some((m) => payload[m].accepting_orders);
  return payload;
}

/* Validate one mode. Returns { error } or { value } */
function validateMode(mode, b) {
  const name = LABEL[mode];
  if (!b || typeof b !== "object") return { error: `${name}: settings missing` };

  const { is_open, opening_time, closing_time, closure_from, closure_to, closed_message } = b;

  if (typeof is_open !== "boolean") return { error: `${name}: is_open must be true or false` };

  const hasHours = opening_time != null || closing_time != null;
  if (hasHours) {
    if (!TIME_RE.test(opening_time || "") || !TIME_RE.test(closing_time || "")) {
      return { error: `${name}: opening and closing time must both be valid (HH:MM)` };
    }
    if (opening_time === closing_time) {
      return { error: `${name}: opening and closing time can't be the same` };
    }
  }

  const hasClosure = closure_from != null || closure_to != null;
  if (hasClosure) {
    if (!isRealDate(closure_from || "") || !isRealDate(closure_to || "")) {
      return { error: `${name}: both closed dates must be valid` };
    }
    if (closure_to < closure_from) {
      return { error: `${name}: the 'To' date must be on or after 'From'` };
    }
    if (closure_to < localNow().date) {
      return { error: `${name}: closed dates are already in the past` };
    }
  }

  const message = typeof closed_message === "string" ? closed_message.trim() : "";
  if (message.length > 140) {
    return { error: `${name}: message must be 140 characters or less` };
  }

  return {
    value: {
      is_open: is_open ? 1 : 0,
      opening_time: hasHours ? opening_time : null,
      closing_time: hasHours ? closing_time : null,
      closure_from: hasClosure ? closure_from : null,
      closure_to: hasClosure ? closure_to : null,
      closed_message: message,
    },
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
// Body: { dine_in: {...}, dine_out: {...} }
///////////////////////////
router.put("/", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const values = {};

    for (const m of MODES) {
      const r = validateMode(m, body[m]);
      if (r.error) return res.status(400).json({ success: false, message: r.error });
      values[m] = r.value;
    }

    const updatedBy = String(
      (req.user && (req.user.name || req.user.email || req.user.username || req.user.id)) || "admin"
    ).slice(0, 100);

    const FIELDS = ["is_open", "opening_time", "closing_time", "closure_from", "closure_to", "closed_message"];
    const cols = [];
    const params = [];
    for (const m of MODES) {
      for (const f of FIELDS) {
        cols.push(`${m}_${f}`);
        params.push(values[m][f]);
      }
    }
    cols.push("updated_by");
    params.push(updatedBy);

    // ---- Save (creates the row if it's missing) ----
    await pool.query(
      `INSERT INTO restaurant_status (id, ${cols.join(", ")})
       VALUES (1, ${cols.map(() => "?").join(", ")})
       ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(", ")}`,
      params
    );

    const status = await getStatusRow();
    const data = buildPayload(status);

    console.log(
      `[RESTAURANT STATUS] ${updatedBy} -> dine_in: ${data.dine_in.accepting_orders ? "OPEN" : "CLOSED"}, dine_out: ${data.dine_out.accepting_orders ? "OPEN" : "CLOSED"}`
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