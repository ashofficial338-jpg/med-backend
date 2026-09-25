import { Router } from "express";
import { body, validationResult } from "express-validator";
import Vendor from "../models/Vendor.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { buildSupplierLedger, vendorOutstandingMap, recordSupplierPayment } from "../utils/ledgerHelpers.js";
import { buildVendorReport } from "../utils/vendorReportHelpers.js";
import { streamExcelReport, streamPdfReport } from "../utils/reportExport.js";

const router = Router();
router.use(requireAuth, requireRole("admin"));

router.get("/", async (req, res) => {
  const { q } = req.query;
  const filter = { isActive: true };
  if (q) {
    filter.$or = [{ name: new RegExp(q, "i") }, { phone: new RegExp(q, "i") }];
  }
  const vendors = await Vendor.find(filter).sort({ name: 1 });
  const outstandingMap = await vendorOutstandingMap();
  res.json(vendors.map((v) => ({ ...v.toObject(), outstandingPayable: outstandingMap.get(String(v._id)) || 0 })));
});

router.get("/:id", async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) return res.status(404).json({ message: "No records found." });
  const { outstandingBalance } = await buildSupplierLedger(vendor._id);
  res.json({ ...vendor.toObject(), outstandingPayable: outstandingBalance });
});

router.get("/:id/ledger", async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) return res.status(404).json({ message: "No records found." });

  const ledger = await buildSupplierLedger(vendor._id);
  res.json({ vendor, ...ledger });
});

router.get("/:id/ledger/export", async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) return res.status(404).json({ message: "No records found." });

  const { entries, outstandingBalance } = await buildSupplierLedger(vendor._id);
  const rows = entries.map((e) => ({
    date: new Date(e.date).toISOString().slice(0, 10),
    type: e.type,
    ref: e.ref,
    debit: e.debit || 0,
    credit: e.credit || 0,
    balance: e.balance,
  }));

  if (req.query.format === "pdf") {
    return streamPdfReport(res, `GHM_Ledger_${vendor.name}.pdf`, {
      title: `${vendor.name} - Vendor Ledger`,
      subtitle: `${vendor.phone} · Outstanding Payable: Rs. ${outstandingBalance.toFixed(2)}`,
      columns: [
        { header: "Date", key: "date" },
        { header: "Type", key: "type" },
        { header: "Ref", key: "ref" },
        { header: "Debit", key: "debit", align: "right" },
        { header: "Credit", key: "credit", align: "right" },
        { header: "Balance", key: "balance", align: "right" },
      ],
      rows,
    });
  }

  return streamExcelReport(res, `GHM_Ledger_${vendor.name}.xlsx`, [
    {
      name: "Ledger",
      columns: [
        { header: "Date", key: "date", width: 14 },
        { header: "Type", key: "type", width: 18 },
        { header: "Ref", key: "ref", width: 16 },
        { header: "Debit", key: "debit", width: 12 },
        { header: "Credit", key: "credit", width: 12 },
        { header: "Balance", key: "balance", width: 12 },
      ],
      rows,
    },
  ]);
});

router.post("/:id/payments", async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) return res.status(404).json({ message: "No records found." });

  const { amount, mode, date, note, purchaseId } = req.body;
  const amountNum = Number(amount);
  if (!(amountNum > 0)) return res.status(400).json({ message: "Please enter a valid number." });

  const result = await recordSupplierPayment({
    vendorId: vendor._id,
    amount: amountNum,
    mode: mode || "Cash",
    date,
    note,
    purchaseId: purchaseId || null,
    recordedBy: req.user._id,
  });
  if (result.error) return res.status(400).json({ message: result.error });

  const ledger = await buildSupplierLedger(vendor._id);
  res.status(201).json({ vendor, ...ledger });
});

router.get("/:id/report", async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) return res.status(404).json({ message: "No records found." });

  const period = req.query.period === "quarter" ? "quarter" : "month";
  const report = await buildVendorReport(vendor._id, period);
  res.json({ vendor, period, report });
});

router.get("/:id/report/export", async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) return res.status(404).json({ message: "No records found." });

  const period = req.query.period === "quarter" ? "quarter" : "month";
  const report = await buildVendorReport(vendor._id, period);

  if (req.query.format === "pdf") {
    return streamPdfReport(res, `GHM_VendorReport_${vendor.name}.pdf`, {
      title: `${vendor.name} - Purchase Report (${period}-wise)`,
      subtitle: `${vendor.phone} · ${vendor.gstNumber}`,
      columns: [
        { header: "Period", key: "period" },
        { header: "Invoices", key: "invoiceCount", align: "right" },
        { header: "Purchases", key: "totalPurchases", align: "right" },
        { header: "Paid", key: "totalPaid", align: "right" },
        { header: "Outstanding", key: "outstanding", align: "right" },
      ],
      rows: report,
    });
  }

  return streamExcelReport(res, `GHM_VendorReport_${vendor.name}.xlsx`, [
    {
      name: "Vendor Report",
      columns: [
        { header: "Period", key: "period", width: 14 },
        { header: "Invoices", key: "invoiceCount", width: 12 },
        { header: "Purchases", key: "totalPurchases", width: 14 },
        { header: "Paid", key: "totalPaid", width: 14 },
        { header: "Outstanding", key: "outstanding", width: 14 },
      ],
      rows: report,
    },
  ]);
});

router.patch("/:id/rating", async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) return res.status(404).json({ message: "No records found." });

  const { quality, reliability, costEfficiency } = req.body;
  for (const [key, value] of Object.entries({ quality, reliability, costEfficiency })) {
    if (value === undefined) continue;
    const num = Number(value);
    if (!(num >= 1 && num <= 5)) return res.status(400).json({ message: "Please enter a valid number." });
    vendor.ratings[key] = num;
  }
  vendor.ratings.ratedAt = new Date();
  await vendor.save();
  res.json(vendor);
});

const vendorValidation = [
  body("name").trim().isLength({ min: 1, max: 150 }).withMessage("This field is required."),
  body("phone").matches(/^\d{10}$/).withMessage("Enter a valid 10-digit phone number."),
  body("gstNumber").trim().isLength({ min: 15, max: 15 }).withMessage("Enter a valid 15-character GSTIN."),
  body("email").optional({ checkFalsy: true }).isEmail().withMessage("Please enter a valid email address."),
];

router.post("/", vendorValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  try {
    const vendor = await Vendor.create(req.body);
    res.status(201).json(vendor);
  } catch (e) {
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

router.patch("/:id", vendorValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) return res.status(404).json({ message: "No records found." });

  Object.assign(vendor, req.body);
  await vendor.save();
  res.json(vendor);
});

router.patch("/:id/active", async (req, res) => {
  const vendor = await Vendor.findById(req.params.id);
  if (!vendor) return res.status(404).json({ message: "No records found." });
  vendor.isActive = Boolean(req.body.isActive);
  await vendor.save();
  res.json(vendor);
});

export default router;
