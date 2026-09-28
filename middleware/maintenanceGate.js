const path = require("path");
const pool = require("../db");

// Paths that must stay reachable even when the site is in maintenance mode —
// otherwise you'd lock yourself out of turning it back off.
const EXEMPT_PREFIXES = [
  "/api/superadmin",
  "/superadmin",
  "/superadminlogin.html",
  "/superadmindashboard.html",
  "/maintenance.html",
  "/api/auth",
  "/admin.html",
  "/admindashboard.html",
  "/adminorders.html",
  "/admincoupons.html",
  "/adminpromotions.html",
];

module.exports = async function maintenanceGate(req, res, next) {
  if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  try {
    const [rows] = await pool.query(
      "SELECT maintenance_enabled FROM site_config WHERE id = 1"
    );
    const enabled = rows.length > 0 && !!rows[0].maintenance_enabled;

    if (!enabled) return next();

    // Customer-facing API calls get a clean 503 instead of the HTML page.
    if (req.path.startsWith("/api/")) {
      return res.status(503).json({
        success: false,
        message: "Delicute is temporarily under maintenance.",
      });
    }

    return res.sendFile(path.join(__dirname, "..", "public", "maintenance.html"));
  } catch (err) {
    console.error("Maintenance gate error:", err);
    next(); // fail open — don't take the whole site down over a DB hiccup
  }
};