import { Router } from "express";
import DayBookAdjustment from "../models/DayBookAdjustment.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { dayBookSummary } from "../utils/dayBookHelpers.js";
import { streamExcelReport, streamPdfReport } from "../utils/reportExport.js";

const router = Router();
router.use(requireAuth, requireRole("admin"));

router.get("/", async (req, res) => {
  const date = req.query.date ? new Date(req.query.date) : new Date();
  const summary = await dayBookSummary(date);
  res.json({ date: date.toISOString().slice(0, 10), ...summary });
});

router.get("/export", async (req, res) => {
  const date = req.query.date ? new Date(req.query.date) : new Date();
  const dateLabel = date.toISOString().slice(0, 10);
  const summary = await dayBookSummary(date);

  const rows = [
    { type: "Cash", ...summary.cash },
    { type: "UPI", ...summary.upi },
    { type: "Credit", ...summary.credit },
  ];

  if (req.query.format === "pdf") {
    return streamPdfReport(res, `GHM_DayBook_${dateLabel}.pdf`, {
      title: "GHM Medical Shop - Day Book",
      subtitle: dateLabel,
      columns: [
        { header: "Type", key: "type" },
        { header: "Opening", key: "opening", align: "right" },
        { header: "In", key: "in", align: "right" },
        { header: "Out", key: "out", align: "right" },
        { header: "Closing", key: "closing", align: "right" },
      ],
      rows,
    });
  }

  return streamExcelReport(res, `GHM_DayBook_${dateLabel}.xlsx`, [
    {
      name: "Day Book",
      columns: [
        { header: "Type", key: "type", width: 12 },
        { header: "Opening", key: "opening", width: 14 },
        { header: "In", key: "in", width: 14 },
        { header: "Out", key: "out", width: 14 },
        { header: "Closing", key: "closing", width: 14 },
      ],
      rows,
    },
  ]);
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
