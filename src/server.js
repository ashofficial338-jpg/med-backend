import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
// Express 4 doesn't catch errors thrown in async route handlers - they become
// unhandled rejections that crash the whole process. This routes them to the
// error handler below instead, so one bad request returns a 500, not a 502.
import "express-async-errors";
import cors from "cors";
import morgan from "morgan";
import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.js";
import profileRoutes from "./routes/profile.js";
import usersRoutes from "./routes/users.js";
import categoriesRoutes from "./routes/categories.js";
import productsRoutes from "./routes/products.js";
import vendorsRoutes from "./routes/vendors.js";
import purchasesRoutes from "./routes/purchases.js";
import stockLedgerRoutes from "./routes/stockLedger.js";
import customersRoutes from "./routes/customers.js";
import salesRoutes from "./routes/sales.js";
import expensesRoutes from "./routes/expenses.js";
import dashboardRoutes from "./routes/dashboard.js";
import daybookRoutes from "./routes/daybook.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Frontends allowed to call this API: the Vite dev server and the Vercel
// deploy, plus any extra origins from CORS_ORIGIN (comma-separated, e.g. a
// custom domain). Registered before every route so all responses get the
// CORS headers.
const allowedOrigins = [
  "http://localhost:5173",
  "https://your-app.vercel.app",
  ...(process.env.CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean) ?? []),
];
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
app.use(express.json());
app.use(morgan("dev"));
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/vendors", vendorsRoutes);
app.use("/api/purchases", purchasesRoutes);
app.use("/api/stock-ledger", stockLedgerRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/day-book", daybookRoutes);

// In a single combined deploy this same process also serves the built React
// app, under the same origin as the API, so no CORS setup or separate
// frontend host is needed. When the frontend is deployed as its own static
// site (client/dist is never built into this service), this block simply
// finds nothing at clientDist and is skipped - the API keeps working on its
// own for a separately-hosted frontend using CORS_ORIGIN + VITE_API_URL.
const clientDist = path.join(__dirname, "..", "..", "client", "dist");
if (process.env.NODE_ENV === "production" && fs.existsSync(path.join(clientDist, "index.html"))) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api|\/uploads).*/, (req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.use((req, res) => {
  res.status(404).json({ message: "No records found." });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Something went wrong. Please try again." });
});

const PORT = process.env.PORT || 5000;

// Fail at startup (visible in the host's deploy logs) rather than on the
// first login, when a missing secret would otherwise surface as a 500.
const missingEnv = ["MONGO_URI", "JWT_SECRET"].filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(", ")}`);
  process.exit(1);
}

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err.message);
    process.exit(1);
  });
