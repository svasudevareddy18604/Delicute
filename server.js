// ================== CORE IMPORTS ==================
const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");
const { Server } = require("socket.io");
const http = require("http");
require("dotenv").config();

// ================== APP & SERVER ==================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      process.env.FRONTEND_URL || "http://localhost:3000",
      "https://delicute-3bf1.onrender.com",
    ],
    credentials: true,
  },
});

// ================== NODMAILER CONFIG ==================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ================== MIDDLEWARE ==================
app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || "http://localhost:3000",
      "https://delicute-3bf1.onrender.com",
    ],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// ================== ROUTES ==================
const authRoutes = require("./routes/auth");
const menuRoutes = require("./routes/menu");
const categoriesRoutes = require("./routes/categories");
const ordersRoutes = require("./routes/orders");
const couponsRoutes = require("./routes/coupons");
const customerMenuRoutes = require("./routes/customermenu");
const promotionsRoutes = require("./routes/promotions");

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/coupons", couponsRoutes);
app.use("/api", customerMenuRoutes);
app.use("/api/promotions", promotionsRoutes);

// ================== WEBSOCKET EVENTS ==================
io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected:", socket.id);
  });
});

// Make io and transporter available to routes
app.set("io", io);
app.set("transporter", transporter);

// ================== STATIC & FRONTEND PAGES ==================
app.use(express.static(path.join(__dirname, "public")));

app.get("/admin", (_, res) => res.redirect("/admin.html"));
app.get("/admindashboard", (_, res) => res.redirect("/admindashboard.html"));
app.get("/orders", (_, res) => res.redirect("/adminorders.html"));
app.get("/coupons", (_, res) => res.redirect("/admincoupons.html"));
app.get("/promotions", (_, res) => res.redirect("/adminpromotions.html"));

// Root
app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ================== 404 HANDLER ==================
app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    return res
      .status(404)
      .json({ success: false, message: "API route not found" });
  }
  res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
