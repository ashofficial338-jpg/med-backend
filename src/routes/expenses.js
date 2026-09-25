import { Router } from "express";
import Expense from "../models/Expense.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { streamExcelReport, streamPdfReport } from "../utils/reportExport.js";

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

router.get("/export", async (req, res) => {
  const { from, to, format } = req.query;
  const filter = {};
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) filter.date.$lte = new Date(to);
  }
  const expenses = await Expense.find(filter).sort({ date: -1 });
  const rows = expenses.map((e) => ({
    date: e.date.toISOString().slice(0, 10),
    category: e.category,
    amount: e.amount,
    paymentMode: e.paymentMode,
    notes: e.notes,
  }));

  if (format === "pdf") {
    return streamPdfReport(res, "GHM_Expenses_Report.pdf", {
      title: "GHM Medical Shop - Expenses Report",
      subtitle: `${rows.length} record(s) · Total: Rs. ${rows.reduce((s, r) => s + r.amount, 0).toFixed(2)}`,
      columns: [
        { header: "Date", key: "date" },
        { header: "Category", key: "category" },
        { header: "Mode", key: "paymentMode" },
        { header: "Amount", key: "amount", align: "right" },
        { header: "Notes", key: "notes" },
      ],
      rows,
    });
  }

  return streamExcelReport(res, "GHM_Expenses_Report.xlsx", [
    {
      name: "Expenses",
      columns: [
        { header: "Date", key: "date", width: 14 },
        { header: "Category", key: "category", width: 16 },
        { header: "Payment Mode", key: "paymentMode", width: 14 },
        { header: "Amount", key: "amount", width: 12 },
        { header: "Notes", key: "notes", width: 30 },
      ],
      rows,
    },
  ]);
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
