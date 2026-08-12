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
const superadminAuthRoutes = require("./routes/superadmin"); // separate superadmin auth system
const superadminMaintenanceRoutes = require("./routes/superadmin-maintenance");
const adminAddonRoutes = require("./routes/adminaddon"); // add-on groups & items
const superadminManageRoutes = require("./routes/superadmin-manage"); // admins & superadmins CRUD
const superadminDashboardRoutes = require("./routes/superadminDashboard"); // ✅ camelCase — has full stats
const superadminOrdersRoutes = require("./routes/superadmin-orders");
const maintenanceGate = require("./middleware/maintenanceGate");
const superadminTablesRoutes = require("./routes/superadmin-tables");
const superadminMenuRoutes = require("./routes/superadmin-menu");
const superadminCategoriesRoutes = require("./routes/superadmin-categories");
const superadminAddonRoutes = require("./routes/superadmin-addon");
const testModeRoutes = require("./routes/testmode"); // public status check
const superadminTestModeRoutes = require("./routes/superadmin-testmode"); // superadmin toggle
const superadminTopPicksRoutes = require("./routes/superadmin-toppicks");
const superadminPromotionsRoutes = require("./routes/superadmin-promotions"); // NEW
const superadminCouponsRoutes = require("./routes/superadmin-coupons");
const superadminAdminLogsRoutes = require("./routes/superadmin-adminlogs");

app.use("/api/superadmin", superadminAdminLogsRoutes); 
app.use("/api/tables", tablesRoutes);
app.use("/api/test-mode", testModeRoutes); // public, must stay above maintenanceGate
app.use(maintenanceGate);
app.use("/api/superadmin/auth", superadminAuthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/coupons", couponsRoutes);
app.use("/api", customerMenuRoutes);
app.use("/api/promotions", promotionsRoutes);
app.use("/api/admin", adminAddonRoutes); // /api/admin/addon-groups, /api/admin/addons
app.use("/api/superadmin/auth", superadminAuthRoutes);
app.use("/api/superadmin/maintenance", superadminMaintenanceRoutes);
app.use("/api/superadmin/dashboard", superadminDashboardRoutes); // ✅ single mount only
app.use("/api/superadmin/orders", superadminOrdersRoutes);
app.use("/api/superadmin", superadminManageRoutes);
app.use("/api/superadmin/tables", superadminTablesRoutes);
app.use("/api/superadmin/menu", superadminMenuRoutes);
app.use("/api/superadmin/categories", superadminCategoriesRoutes);
app.use("/api/superadmin/addons", superadminAddonRoutes);
app.use("/api/superadmin/test-mode", superadminTestModeRoutes);
app.use("/api/superadmin/toppicks", superadminTopPicksRoutes);
app.use("/api/superadmin/promotions", superadminPromotionsRoutes);
app.use("/api/superadmin/coupons", superadminCouponsRoutes);

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

  // Customer's browser joins a private room named after its own anonymous
  // session id. Order-status updates are emitted to "session:<id>" from
  // routes/orders.js, so only this browser receives its own order's updates.
  socket.on("join-session", (sessionId) => {
    if (!sessionId || typeof sessionId !== "string") return;
    socket.join(`session:${sessionId}`);
    console.log(`🙋 Socket ${socket.id} joined room session:${sessionId}`);
  });

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

// superadmin console redirects
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