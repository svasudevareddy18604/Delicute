// middleware/authenticate.js
const jwt = require("jsonwebtoken");

module.exports = function authenticate(req, res, next) {
  try {
    const token = req.cookies?.token; // read from cookies
    if (!token) {
      return res.status(401).json({ success: false, message: "Unauthorized: No token" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // attach user info
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Unauthorized: Invalid token" });
  }
};
