// routes/auth.js
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../db"); // MySQL pool
const geoip = require("geoip-lite");
const router = express.Router();

// ================== HELPERS ==================
function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || req.ip || null;
}

// Returns the exact current time in IST, formatted for MySQL DATETIME.
// Computed in Node regardless of what timezone the MySQL server itself
// runs in — avoids the UTC-vs-IST mismatch from relying on NOW().
function mysqlNowIST() {
  const istString = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const d = new Date(istString);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Resolves a rough "City, Region, Country" string from an IP using an
// offline lookup table (no external API call, no network dependency).
// Localhost / private-network IPs (127.0.0.1, 192.168.x.x, ::1, etc.)
// have no public geo record, so those correctly return null — this is
// expected during local dev and is NOT a bug.
function lookupLocation(ip) {
  if (!ip) return null;
  const cleanIp = ip.replace("::ffff:", ""); // strip IPv6-mapped-IPv4 prefix
  if (
    cleanIp === "127.0.0.1" ||
    cleanIp === "::1" ||
    cleanIp.startsWith("192.168.") ||
    cleanIp.startsWith("10.") ||
    cleanIp.startsWith("172.")
  ) {
    return "Local network";
  }
  const geo = geoip.lookup(cleanIp);
  if (!geo) return null;
  const parts = [geo.city, geo.region, geo.country].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

async function logAdminAttempt({ adminId, email, ip, userAgent, success, reason }) {
  try {
    const location = lookupLocation(ip);
    await pool.query(
      `INSERT INTO admin_login_logs
        (admin_id, email_attempted, ip_address, location, user_agent, success, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [adminId || null, email, ip, location, userAgent || null, success ? 1 : 0, reason || null, mysqlNowIST()]
    );
  } catch (err) {
    console.error("Admin login log error:", err);
  }
}

// ------------------ SIGNUP ------------------
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const [existing] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    if (existing.length > 0) {
      return res.status(400).json({ message: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
      [name, email, hashedPassword, "admin"]
    );

    res.status(201).json({ message: "Signup successful" });
  } catch (err) {
    console.error("Signup Error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------ LOGIN ------------------
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const ip = getClientIp(req);
  const userAgent = req.headers["user-agent"];

  try {
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const [users] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    if (users.length === 0) {
      await logAdminAttempt({ email, ip, userAgent, success: false, reason: "no_account" });
      return res.status(400).json({ message: "Invalid email or password" });
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      await logAdminAttempt({ adminId: user.id, email, ip, userAgent, success: false, reason: "bad_password" });
      return res.status(400).json({ message: "Invalid email or password" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 2 * 60 * 60 * 1000,
    });

    await logAdminAttempt({ adminId: user.id, email, ip, userAgent, success: true, reason: "ok" });

    res.json({ message: "Login successful" });
  } catch (err) {
    console.error("Login Error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------ AUTH CHECK ------------------
router.get("/check", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ message: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ success: true, user: decoded });
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
});

// ------------------ LOGOUT ------------------
router.post("/logout", (req, res) => {
  res.clearCookie("token", { path: "/" });
  res.json({ message: "Logged out" });
});

module.exports = router;