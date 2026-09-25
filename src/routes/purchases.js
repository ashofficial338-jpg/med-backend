import { Router } from "express";
import Purchase from "../models/Purchase.js";
import Vendor from "../models/Vendor.js";
import Product from "../models/Product.js";
import StockLedger from "../models/StockLedger.js";
import SupplierPayment from "../models/SupplierPayment.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { computeInternalQty } from "../utils/stockUnits.js";
import { upsertBatch } from "../utils/batchHelpers.js";
import { generatePaymentNo } from "../utils/ledgerHelpers.js";
import { streamExcelReport, streamPdfReport } from "../utils/reportExport.js";

const router = Router();
router.use(requireAuth, requireRole("admin"));

router.get("/", async (req, res) => {
  const { vendor, from, to } = req.query;
  const filter = {};
  if (vendor) filter.vendor = vendor;
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) filter.date.$lte = new Date(to);
  }
  const purchases = await Purchase.find(filter)
    .populate("vendor", "name")
    .populate("items.product", "name productCode")
    .sort({ date: -1, createdAt: -1 });
  res.json(purchases);
});

// Registered before GET "/:id" - both are single-segment GET routes, and
// Express matches in registration order, so this must come first or "/:id"
// would treat "export" as a purchase id.
router.get("/export", async (req, res) => {
  const { vendor, from, to, format } = req.query;
  const filter = {};
  if (vendor) filter.vendor = vendor;
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) filter.date.$lte = new Date(to);
  }
  const purchases = await Purchase.find(filter).populate("vendor", "name").sort({ date: -1, createdAt: -1 });
  const rows = purchases.map((p) => ({
    invoiceNo: p.invoiceNo,
    date: p.date.toISOString().slice(0, 10),
    vendor: p.vendor?.name || "",
    paymentMode: p.paymentMode,
    subtotal: p.subtotal,
    gst: p.gstAmount,
    tds: p.tdsAmount,
    total: p.total,
    amountPaid: p.amountPaid ?? p.total,
    balanceDue: p.balanceDue,
  }));

  if (format === "pdf") {
    return streamPdfReport(res, "GHM_Purchases_Report.pdf", {
      title: "GHM Medical Shop - Purchases Report",
      subtitle: `${rows.length} invoice(s)`,
      columns: [
        { header: "Invoice No", key: "invoiceNo" },
        { header: "Date", key: "date" },
        { header: "Vendor", key: "vendor" },
        { header: "Mode", key: "paymentMode" },
        { header: "Total", key: "total", align: "right" },
        { header: "Balance Due", key: "balanceDue", align: "right" },
      ],
      rows,
    });
  }

  return streamExcelReport(res, "GHM_Purchases_Report.xlsx", [
    {
      name: "Purchases",
      columns: [
        { header: "Invoice No", key: "invoiceNo", width: 16 },
        { header: "Date", key: "date", width: 14 },
        { header: "Vendor", key: "vendor", width: 20 },
        { header: "Payment Mode", key: "paymentMode", width: 14 },
        { header: "Subtotal", key: "subtotal", width: 12 },
        { header: "GST", key: "gst", width: 12 },
        { header: "TDS", key: "tds", width: 12 },
        { header: "Total", key: "total", width: 12 },
        { header: "Amount Paid", key: "amountPaid", width: 12 },
        { header: "Balance Due", key: "balanceDue", width: 12 },
      ],
      rows,
    },
  ]);
});

router.get("/:id", async (req, res) => {
  const purchase = await Purchase.findById(req.params.id)
    .populate("vendor", "name")
    .populate("items.product", "name productCode packUnit soldAs unitsPerPack");
  if (!purchase) return res.status(404).json({ message: "No records found." });
  res.json(purchase);
});

router.post("/", async (req, res) => {
  const { vendor, invoiceNo, date, items, tdsAmount, paymentMode, amountPaid } = req.body;

  if (!vendor) return res.status(400).json({ message: "This field is required." });
  if (!invoiceNo || !invoiceNo.trim()) return res.status(400).json({ message: "This field is required." });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Add at least one product line before saving." });
  }

  const vendorDoc = await Vendor.findById(vendor);
  if (!vendorDoc || !vendorDoc.isActive) {
    return res.status(400).json({ message: "No records found." });
  }

  try {
    const resolvedItems = [];
    let subtotal = 0;
    let gstAmount = 0;

    for (const item of items) {
      const product = await Product.findById(item.product);
      if (!product) {
        return res.status(400).json({ message: "This field is required." });
      }
      const qtyPacks = Number(item.qtyPacks);
      const costPrice = Number(item.costPrice);
      if (!(qtyPacks > 0)) return res.status(400).json({ message: "Please enter a valid number." });
      if (!(costPrice >= 0)) return res.status(400).json({ message: "Please enter a valid number." });
      if (!item.batchNo) return res.status(400).json({ message: "This field is required." });
      if (!item.expiryDate) return res.status(400).json({ message: "Please enter a valid date." });

      const lineAmount = Number((qtyPacks * costPrice).toFixed(2));
      const lineGst = Number(((lineAmount * product.gstPercent) / 100).toFixed(2));

      subtotal += lineAmount;
      gstAmount += lineGst;

      resolvedItems.push({
        product: product._id,
        qtyPacks,
        costPrice,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate,
        lineAmount,
        lineGst,
        _productDoc: product,
      });
    }

    subtotal = Number(subtotal.toFixed(2));
    gstAmount = Number(gstAmount.toFixed(2));
    const total = Number((subtotal + gstAmount).toFixed(2));

    // A non-Credit purchase is settled in full immediately; Credit is the
    // only mode that can carry a payable balance forward.
    const resolvedPaymentMode = paymentMode || "Credit";
    const resolvedAmountPaid =
      resolvedPaymentMode === "Credit" ? Math.min(Math.max(Number(amountPaid) || 0, 0), total) : total;

    const purchase = await Purchase.create({
      vendor,
      invoiceNo: invoiceNo.trim(),
      date,
      items: resolvedItems.map(({ _productDoc, ...rest }) => rest),
      subtotal,
      gstAmount,
      tdsAmount: Number(tdsAmount) || 0,
      total,
      paymentMode: resolvedPaymentMode,
      amountPaid: resolvedAmountPaid,
      createdBy: req.user._id,
    });

    if (resolvedPaymentMode === "Credit" && resolvedAmountPaid > 0) {
      const paymentNo = await generatePaymentNo("supplier");
      await SupplierPayment.create({
        paymentNo,
        vendor,
        purchase: purchase._id,
        amount: resolvedAmountPaid,
        note: "Paid at purchase",
        recordedBy: req.user._id,
      });
    }

    // Stock-in: each line creates (or tops up, if this exact batch number
    // already exists for the product) its own Batch row, so an older lot's
    // expiry is never overwritten by a newer delivery's.
    for (let i = 0; i < resolvedItems.length; i++) {
      const item = resolvedItems[i];
      const product = item._productDoc;
      const addQty = computeInternalQty({
        soldAs: product.soldAs,
        unitsPerPack: product.unitsPerPack,
        qtyPacks: item.qtyPacks,
        qtyLooseExtra: 0,
      });

      const batch = await upsertBatch({
        product,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate,
        costPrice: item.costPrice,
        addQty,
        receivedAt: date,
        purchase: purchase._id,
      });
      purchase.items[i].batch = batch._id;

      product.qty += addQty;
      await product.save();

      await StockLedger.create({
        product: product._id,
        batch: batch._id,
        type: "purchase",
        qtyChange: addQty,
        reason: `Purchase invoice ${purchase.invoiceNo}`,
        refId: purchase._id,
        performedBy: req.user._id,
      });
    }

    await purchase.save();

    const populated = await purchase.populate([
      { path: "vendor", select: "name" },
      { path: "items.product", select: "name productCode" },
    ]);
    res.status(201).json(populated);
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({ message: "This invoice number has already been recorded for this vendor." });
    }
    if (e.name === "ValidationError") {
      return res.status(400).json({ message: Object.values(e.errors)[0].message });
    }
    console.error(e);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

export default router;
