import { Router } from "express";
import { body, validationResult } from "express-validator";
import Vendor from "../models/Vendor.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { buildSupplierLedger, vendorOutstandingMap, recordSupplierPayment } from "../utils/ledgerHelpers.js";
import { buildVendorReport } from "../utils/vendorReportHelpers.js";

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
