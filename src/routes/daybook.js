import { Router } from "express";
import DayBookAdjustment from "../models/DayBookAdjustment.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { dayBookSummary } from "../utils/dayBookHelpers.js";

const router = Router();
router.use(requireAuth, requireRole("admin"));

router.get("/", async (req, res) => {
  const date = req.query.date ? new Date(req.query.date) : new Date();
  const summary = await dayBookSummary(date);
  res.json({ date: date.toISOString().slice(0, 10), ...summary });
});

router.post("/adjustments", async (req, res) => {
  const { type, date, balance, note } = req.body;
  if (!["Cash", "UPI", "Credit"].includes(type)) {
    return res.status(400).json({ message: "This field is required." });
  }
  if (!date) return res.status(400).json({ message: "Please enter a valid date." });
  if (!(Number(balance) >= 0)) return res.status(400).json({ message: "Please enter a valid number." });

  await DayBookAdjustment.create({
    type,
    date,
    balance: Number(balance),
    note: note || "",
    setBy: req.user._id,
  });

  const summary = await dayBookSummary(new Date(date));
  res.status(201).json({ date, ...summary });
});

export default router;
