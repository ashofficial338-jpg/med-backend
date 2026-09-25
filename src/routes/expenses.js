import { Router } from "express";
import Expense from "../models/Expense.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("admin"));

router.get("/", async (req, res) => {
  const { from, to } = req.query;
  const filter = {};
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) filter.date.$lte = new Date(to);
  }
  const expenses = await Expense.find(filter).sort({ date: -1 });
  res.json(expenses);
});

router.post("/", async (req, res) => {
  const { category, amount, date, notes, paymentMode } = req.body;
  if (!["Rent", "Salary", "Utilities", "Other"].includes(category)) {
    return res.status(400).json({ message: "This field is required." });
  }
  if (!(Number(amount) > 0)) return res.status(400).json({ message: "Please enter a valid number." });
  if (!date) return res.status(400).json({ message: "Please enter a valid date." });

  const expense = await Expense.create({
    category,
    amount: Number(amount),
    paymentMode: ["Cash", "UPI", "Card", "Other"].includes(paymentMode) ? paymentMode : "Cash",
    date,
    notes: notes || "",
    createdBy: req.user._id,
  });
  res.status(201).json(expense);
});

export default router;
