// ================== SUPERADMIN AUTH ROUTES ==================
// Entirely separate auth system from /api/auth (restaurant admins).
// - Separate table (superadmins)
// - Separate JWT secret (SUPERADMIN_JWT_SECRET)
// - Separate cookie name (superadmin_token)
// - OTP second factor, emailed via the same nodemailer transporter
// - Every attempt (success or failure) is logged to superadmin_login_logs
//
// Mounted in server.js as: app.use("/api/superadmin/auth", superadminAuthRoutes);

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db"); // same MySQL pool used elsewhere

const JWT_SECRET = process.env.SUPERADMIN_JWT_SECRET;
const COOKIE_NAME = "superadmin_token";
const TOKEN_TTL = "8h";
const OTP_TTL_MINUTES = 10;
const IS_PROD = process.env.NODE_ENV === "production";

if (!JWT_SECRET) {
  console.error(
    "❌ SUPERADMIN_JWT_SECRET is not set. Add it to your .env — do NOT reuse the regular admin JWT secret."
  );
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || req.ip || null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: IS_PROD,               // must be true in production (HTTPS)
    sameSite: IS_PROD ? "none" : "lax", // "none" needed if frontend/backend are on different subdomains
    maxAge: 8 * 60 * 60 * 1000,    // 8 hours, matches TOKEN_TTL
    path: "/",
  };
}

// ================== MIDDLEWARE ==================
// Defined up top (not at the bottom) so it can be used by /logs and any
// other protected route declared below in this same file.
function authenticateSuperadmin(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ success: false, message: "Not authenticated" });

  try {
    req.superadmin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Session expired or invalid" });
  }
}

async function logAttempt({ superadminId, email, ip, userAgent, success, reason }) {
  try {
    await pool.query(
      `INSERT INTO superadmin_login_logs
        (superadmin_id, email_attempted, ip_address, user_agent, success, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [superadminId || null, email, ip, userAgent || null, success ? 1 : 0, reason || null]
    );
  } catch (err) {
    // Never let logging failures break the login flow.
    console.error("Superadmin login log error:", err);
  }
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit code
}

// ================== LOGIN (STEP 1: email + password) ==================
// If otp_enabled, this issues a code by email and responds { otpRequired: true }
// instead of a session — the client then re-submits with the otp field filled in.
router.post("/login", async (req, res) => {
  const { email, password, otp } = req.body;
  const ip = getClientIp(req);
  const userAgent = req.headers["user-agent"];

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password are required" });
  }

  try {
    const [rows] = await pool.query(
      "SELECT * FROM superadmins WHERE email = ? LIMIT 1",
      [email.trim().toLowerCase()]
    );

    if (rows.length === 0) {
      await logAttempt({ email, ip, userAgent, success: false, reason: "no_account" });
      return res.status(401).json({ success: false, message: "Invalid login credentials" });
    }

    const account = rows[0];

    if (!account.is_active) {
      await logAttempt({ superadminId: account.id, email, ip, userAgent, success: false, reason: "inactive" });
      return res.status(403).json({ success: false, message: "This account has been deactivated" });
    }

    const passwordOk = await bcrypt.compare(password, account.password_hash);
    if (!passwordOk) {
      await logAttempt({ superadminId: account.id, email, ip, userAgent, success: false, reason: "bad_password" });
      return res.status(401).json({ success: false, message: "Invalid login credentials" });
    }

    // ---- 2FA branch ----
    if (account.otp_enabled) {
      if (!otp) {
        // Step 1 succeeded — issue and email a fresh OTP, ask for step 2.
        const code = generateOtp();
        const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

        await pool.query(
          "INSERT INTO superadmin_otps (superadmin_id, otp_code, expires_at) VALUES (?, ?, ?)",
          [account.id, code, expiresAt]
        );

        const transporter = req.app.get("transporter");
        if (transporter) {
          try {
            await transporter.sendMail({
              from: process.env.EMAIL_USER,
              to: account.email,
              subject: "Delicute Super Admin — Verification Code",
              html: `
                <h2>🔐 Super Admin Login</h2>
                <p>Your verification code is:</p>
                <h1 style="letter-spacing:4px;">${code}</h1>
                <p>This code expires in ${OTP_TTL_MINUTES} minutes. If this wasn't you, secure your account immediately.</p>
              `,
            });
          } catch (mailErr) {
            console.error("Failed to send superadmin OTP email:", mailErr);
            return res.status(500).json({ success: false, message: "Could not send verification code. Try again." });
          }
        } else {
          console.error("No transporter configured on app — cannot send OTP");
          return res.status(500).json({ success: false, message: "Verification system unavailable" });
        }

        return res.json({ success: true, otpRequired: true });
      }

      // Step 2 — verify the submitted OTP.
      const [otpRows] = await pool.query(
        `SELECT * FROM superadmin_otps
         WHERE superadmin_id = ? AND otp_code = ? AND consumed = 0 AND expires_at > NOW()
         ORDER BY id DESC LIMIT 1`,
        [account.id, otp.trim()]
      );

      if (otpRows.length === 0) {
        await logAttempt({ superadminId: account.id, email, ip, userAgent, success: false, reason: "bad_otp" });
        return res.status(401).json({ success: false, message: "Invalid or expired verification code" });
      }

      await pool.query("UPDATE superadmin_otps SET consumed = 1 WHERE id = ?", [otpRows[0].id]);
    }

    // ---- Issue session ----
    const token = jwt.sign(
      { id: account.id, email: account.email, role: "superadmin" },
      JWT_SECRET,
      { expiresIn: TOKEN_TTL }
    );

    res.cookie(COOKIE_NAME, token, cookieOptions());

    await pool.query(
      "UPDATE superadmins SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?",
      [ip, account.id]
    );
    await logAttempt({ superadminId: account.id, email, ip, userAgent, success: true, reason: "ok" });

    res.json({ success: true, name: account.name, email: account.email });
  } catch (err) {
    console.error("Superadmin login error:", err);
    res.status(500).json({ success: false, message: "Server error during login" });
  }
});

// ================== CURRENT SUPERADMIN (for dashboard header) ==================
router.get("/me", async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ success: false, message: "Not authenticated" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const [rows] = await pool.query(
      "SELECT id, name, email FROM superadmins WHERE id = ? LIMIT 1",
      [payload.id]
    );
    if (rows.length === 0) return res.status(401).json({ success: false, message: "Account not found" });
    res.json({ success: true, name: rows[0].name, email: rows[0].email });
  } catch (err) {
    res.status(401).json({ success: false, message: "Session expired or invalid" });
  }
});

// ================== AUTH CHECK ==================
router.get("/check", async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ success: false, message: "Not authenticated" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ success: true, email: payload.email });
  } catch (err) {
    res.status(401).json({ success: false, message: "Session expired or invalid" });
  }
});

// ================== LOGOUT ==================
router.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: 0 });
  res.json({ success: true, message: "Logged out" });
});

// ================== LOGIN LOGS (for the Login Logs page) ==================
// GET /api/superadmin/logs?q=&success=&limit=
router.get("/logs", authenticateSuperadmin, async (req, res) => {
  try {
    const { q = "", success = "", limit = "50" } = req.query;

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);

    let sql = `SELECT id, superadmin_id, email_attempted, ip_address, user_agent, success, reason, created_at
               FROM superadmin_login_logs WHERE 1=1`;
    const params = [];

    if (q.trim()) {
      sql += ` AND (email_attempted LIKE ? OR ip_address LIKE ?)`;
      params.push(`%${q.trim()}%`, `%${q.trim()}%`);
    }

    if (success === "1" || success === "0") {
      sql += ` AND success = ?`;
      params.push(success === "1" ? 1 : 0);
    }

    sql += ` ORDER BY id DESC LIMIT ?`;
    params.push(safeLimit);

    const [rows] = await pool.query(sql, params);

    res.json({ success: true, logs: rows });
  } catch (err) {
    console.error("Fetch superadmin logs error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch login logs" });
  }
});

module.exports = router;
module.exports.authenticateSuperadmin = authenticateSuperadmin;