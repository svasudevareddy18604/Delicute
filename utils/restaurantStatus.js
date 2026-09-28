const pool = require("../db");

// Restaurant's local timezone (set RESTAURANT_TZ in .env to change)
const TZ = process.env.RESTAURANT_TZ || "Asia/Kolkata";

const EMPTY = {
  is_open: true,
  opening_time: null,
  closing_time: null,
  closure_from: null,
  closure_to: null,
  closed_message: "",
  updated_by: null,
  updated_at: null,
};

/* Read the single status row. Times come back as "HH:MM", dates as "YYYY-MM-DD". */
async function getStatusRow() {
  const [rows] = await pool.query(
    `SELECT is_open,
            TIME_FORMAT(opening_time, '%H:%i') AS opening_time,
            TIME_FORMAT(closing_time, '%H:%i') AS closing_time,
            DATE_FORMAT(closure_from, '%Y-%m-%d') AS closure_from,
            DATE_FORMAT(closure_to,   '%Y-%m-%d') AS closure_to,
            closed_message, updated_by, updated_at
     FROM restaurant_status
     WHERE id = 1
     LIMIT 1`
  );
  if (!rows.length) return { ...EMPTY };
  return { ...rows[0], is_open: !!rows[0].is_open };
}

/* Current date + minutes-since-midnight in the restaurant's timezone */
function localNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

const toMinutes = (t) => {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m);
};

const fmt12 = (t) => {
  const [h, m] = t.split(":");
  return `${Number(h) % 12 || 12}:${m} ${Number(h) >= 12 ? "PM" : "AM"}`;
};

const nextDay = (dateStr) => {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/*
  Decide if orders are allowed right now.
  Order of checks: manual switch -> closed dates -> opening hours.
  Returns { accepting, reason, message, reopens_on }
*/
function evaluate(s) {
  const now = localNow();

  if (!s.is_open) {
    return {
      accepting: false,
      reason: "manual",
      message: s.closed_message || "We're closed right now. Please check back soon.",
      reopens_on: null,
    };
  }

  if (s.closure_from && s.closure_to && now.date >= s.closure_from && now.date <= s.closure_to) {
    return {
      accepting: false,
      reason: "closure",
      message: s.closed_message || "We're closed for a short break. Please check back soon.",
      reopens_on: nextDay(s.closure_to),
    };
  }

  if (s.opening_time && s.closing_time) {
    const o = toMinutes(s.opening_time);
    const e = toMinutes(s.closing_time);
    // Overnight windows (e.g. 6 PM to 2 AM) wrap past midnight
    const inside = o < e ? now.minutes >= o && now.minutes < e : now.minutes >= o || now.minutes < e;
    if (!inside) {
      return {
        accepting: false,
        reason: "hours",
        message: s.closed_message || `We're closed right now. We open at ${fmt12(s.opening_time)}.`,
        reopens_on: null,
      };
    }
  }

  return { accepting: true, reason: null, message: "", reopens_on: null };
}

module.exports = { getStatusRow, evaluate, localNow, TZ };