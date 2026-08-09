// middleware/authenticate.js
const jwt = require("jsonwebtoken");

module.exports = function authenticate(req, res, next) {
  console.log("🔍 Incoming cookies:", req.cookies);
  console.log("🔍 Raw cookie header:", req.headers.cookie);

  try {
    const token = req.cookies?.token;
    if (!token) {
      return res.status(401).json({ success: false, message: "Unauthorized: No token" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    console.log("🔍 JWT verify error:", err.message);
    return res.status(401).json({ success: false, message: "Unauthorized: Invalid token" });
  }
};