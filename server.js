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
      "https://delicute-kxc9.onrender.com",
    ],
    credentials: true,
  },
});

// ================== NODMAILER CONFIG ==================
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 30000,
});

// Verify SMTP connection on startup
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ SMTP Connection Error:");
    console.error(error);
  } else {
    console.log("✅ SMTP Server Ready");
  }
});

// ================== MIDDLEWARE ==================
app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || "http://localhost:3000",
      "https://delicute-3bf1.onrender.com",
      "https://delicute-kxc9.onrender.com",
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
const tablesRoutes = require("./routes/tables");
const promotionsRoutes = require("./routes/promotions");
const superadminAuthRoutes = require("./routes/superadmin"); // NEW — separate superadmin auth system
const superadminMaintenanceRoutes = require("./routes/superadmin-maintenance");

const superadminDashboardRoutes = require("./routes/superadmin-dashboard");
const superadminOrdersRoutes = require("./routes/superadmin-orders");
const maintenanceGate = require("./middleware/maintenanceGate");

app.use("/api/tables", tablesRoutes);
app.use(maintenanceGate);
app.use("/api/auth", authRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/coupons", couponsRoutes);
app.use("/api", customerMenuRoutes);
app.use("/api/promotions", promotionsRoutes);
app.use("/api/superadmin/auth", superadminAuthRoutes); // NEW
app.use("/api/superadmin/maintenance", superadminMaintenanceRoutes);
app.use("/api/superadmin/dashboard", superadminDashboardRoutes);
app.use("/api/superadmin/orders", superadminOrdersRoutes);

// ================== TEST EMAIL ROUTE ==================
app.get("/test-email", async (req, res) => {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER,
      subject: "Delicute SMTP Test",
      text: "SMTP is working successfully from Render.",
    });

    res.send("✅ Test email sent successfully.");
  } catch (err) {
    console.error("Email Test Error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
      error: err,
    });
  }
});

// ================== WEBSOCKET ==================
io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected:", socket.id);
  });
});

// Make available in routes
app.set("io", io);
app.set("transporter", transporter);

// ================== STATIC FILES ==================
app.use(express.static(path.join(__dirname, "public")));

app.get("/admin", (_, res) =>
  res.redirect("/admin.html")
);

app.get("/admindashboard", (_, res) =>
  res.redirect("/admindashboard.html")
);

app.get("/orders", (_, res) =>
  res.redirect("/adminorders.html")
);

app.get("/coupons", (_, res) =>
  res.redirect("/admincoupons.html")
);

app.get("/promotions", (_, res) =>
  res.redirect("/adminpromotions.html")
);

// NEW — superadmin console redirects
app.get("/superadmin", (_, res) =>
  res.redirect("/superadminlogin.html")
);

app.get("/superadmindashboard", (_, res) =>
  res.redirect("/superadmindashboard.html")
);

// ================== HOME ==================
app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ================== 404 ==================
app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({
      success: false,
      message: "API route not found",
    });
  }

  res.status(404).sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
});