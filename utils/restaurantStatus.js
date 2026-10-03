const pool = require("../db");

const MODES = ["dine_in", "dine_out"];
const TZ = process.env.RESTAURANT_TZ || "Asia/Kolkata";

/* Current date + minutes-of-day in the restaurant's timezone */
function localNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  let h = +get("hour");
  if (h === 24) h = 0;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: h * 60 + +get("minute"),
  };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const toDateStr = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};
const toTimeStr = (v) => (v ? String(v).slice(0, 5) : null);
const toMins = (t) => {
  const [h, m] = t.split(":");
  return +h * 60 + +m;
};

function readMode(row, prefix) {
  return {
    is_open: row[`${prefix}_is_open`] === 1 || row[`${prefix}_is_open`] === true || row[`${prefix}_is_open`] === "1",
    opening_time: toTimeStr(row[`${prefix}_opening_time`]),
    closing_time: toTimeStr(row[`${prefix}_closing_time`]),
    closure_from: toDateStr(row[`${prefix}_closure_from`]),
    closure_to: toDateStr(row[`${prefix}_closure_to`]),
    closed_message: row[`${prefix}_closed_message`] || "",
  };
}

/* Returns { dine_in: {...}, dine_out: {...}, updated_at } */
async function getStatusRow() {
  const [rows] = await pool.query("SELECT * FROM restaurant_status WHERE id = 1 LIMIT 1");
  const row = rows[0] || {};
  const hasRow = rows.length > 0;
  const out = { updated_at: row.updated_at || null };
  for (const m of MODES) {
    out[m] = hasRow
      ? readMode(row, m)
      : { is_open: true, opening_time: null, closing_time: null, closure_from: null, closure_to: null, closed_message: "" };
  }
  return out;
}

/* Is ONE mode accepting orders right now? */
function evaluateMode(s, now = localNow()) {
  if (!s.is_open) {
    return { accepting: false, reason: "manual", reopens_on: null };
  }
  if (s.closure_from && s.closure_to && now.date >= s.closure_from && now.date <= s.closure_to) {
    return { accepting: false, reason: "closure", reopens_on: addDays(s.closure_to, 1) };
  }
  if (s.opening_time && s.closing_time) {
    const o = toMins(s.opening_time);
    const c = toMins(s.closing_time);
    const inside = o < c ? now.minutes >= o && now.minutes < c : now.minutes >= o || now.minutes < c;
    if (!inside) return { accepting: false, reason: "hours", reopens_on: null };
  }
  return { accepting: true, reason: null, reopens_on: null };
}

/* Both modes at once */
function evaluate(status) {
  const now = localNow();
  return {
    dine_in: evaluateMode(status.dine_in, now),
    dine_out: evaluateMode(status.dine_out, now),
  };
}

/* Use this in your ORDER route:
   const r = await isAccepting("dine_out");   // or "dine_in"
   if (!r.accepting) return res.status(403).json({ success:false, message:"Restaurant is closed" }); */
async function isAccepting(mode) {
  if (!MODES.includes(mode)) throw new Error("Invalid order mode: " + mode);
  const status = await getStatusRow();
  return { ...evaluateMode(status[mode]), message: status[mode].closed_message };
}

module.exports = { MODES, getStatusRow, evaluateMode, evaluate, isAccepting, localNow, addDays };