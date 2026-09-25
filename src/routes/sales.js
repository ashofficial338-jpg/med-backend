import { Router } from "express";
import Sale from "../models/Sale.js";
import Product from "../models/Product.js";
import Customer from "../models/Customer.js";
import StockLedger from "../models/StockLedger.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { saleLineInternalQty, generateBillNo, buildBillText } from "../utils/saleHelpers.js";
import { streamBillPdf } from "../utils/billPdf.js";
import { allocateFefo, reverseBreakdown, earliestActiveBatch, landLegacyReturn } from "../utils/batchHelpers.js";

const router = Router();
router.use(requireAuth);

function canAccessSale(sale, user) {
  return user.role === "admin" || String(sale.createdBy) === String(user._id);
}

router.get("/", async (req, res) => {
  const { q, from, to } = req.query;
  const filter = {};
  if (req.user.role === "staff") filter.createdBy = req.user._id;
  if (q) filter.billNo = new RegExp(q, "i");
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }

  const sales = await Sale.find(filter)
    .populate("customer", "name phone")
    .populate("createdBy", "username")
    .sort({ createdAt: -1 })
    .limit(200);
  res.json(sales);
});

router.get("/:id", async (req, res) => {
  const sale = await Sale.findById(req.params.id).populate("customer", "name phone").populate("createdBy", "username");
  if (!sale) return res.status(404).json({ message: "No records found." });
  if (!canAccessSale(sale, req.user)) return res.status(403).json({ message: "You do not have permission to perform this action." });
  res.json({ ...sale.toObject(), billText: buildBillText(sale) });
});

router.get("/:id/pdf", async (req, res) => {
  const sale = await Sale.findById(req.params.id).populate("customer", "name phone").populate("createdBy", "username");
  if (!sale) return res.status(404).json({ message: "No records found." });
  if (!canAccessSale(sale, req.user)) return res.status(403).json({ message: "You do not have permission to perform this action." });
  streamBillPdf(sale, res);
});

router.post("/", async (req, res) => {
  const { customer, items, paymentMode, discount, overrideExpiredReason } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Add at least one product to the cart before completing payment." });
  }

  const isAdmin = req.user.role === "admin";
  const now = new Date();
  const resolved = [];

  try {
    for (const item of items) {
      const product = await Product.findById(item.product);
      if (!product || !product.isActive) {
        return res.status(400).json({ message: "This product is no longer available." });
      }
      if (item.unitType === "loose" && product.soldAs !== "pack-and-loose") {
        return res.status(400).json({ message: "This product cannot be sold loose." });
      }

      // FEFO means the batch that's about to run out first is always the one
      // a sale would actually draw from, so that's the expiry that matters here.
      const nextBatch = await earliestActiveBatch(product._id);
      const isExpired = nextBatch && new Date(nextBatch.expiryDate) < now;
      if (isExpired && !(isAdmin && overrideExpiredReason)) {
        return res.status(400).json({ message: "This batch has expired and cannot be sold." });
      }

      const qty = Number(item.qty);
      if (!(qty > 0)) return res.status(400).json({ message: "Please enter a valid number." });

      const internalQty = saleLineInternalQty(product, item.unitType, qty);
      const rate = item.unitType === "pack" ? product.packRate : product.looseRate;
      const unitLabel = item.unitType === "pack" ? product.packUnit : product.looseUnitName;
      const amount = Number((qty * rate).toFixed(2));
      const gstAmount = Number(((amount * product.gstPercent) / 100).toFixed(2));

      resolved.push({
        product,
        internalQty,
        line: {
          product: product._id,
          name: product.name,
          hsnCode: product.hsnCode || "",
          unitType: item.unitType,
          unitLabel,
          qty,
          rate,
          gstPercent: product.gstPercent,
          amount,
          gstAmount,
        },
      });
    }

    // Guarded, atomic decrement per line against the product's total (race-safe
    // against concurrent sales), then FEFO-allocate that same quantity across
    // the product's batches so cost/expiry are always attributed to the actual
    // lot(s) it came from. If anything fails partway, everything already
    // reserved for earlier lines - both the product total and batch qtys - is put back.
    const settled = [];
    for (const { product, internalQty, line } of resolved) {
      const updated = await Product.findOneAndUpdate(
        { _id: product._id, qty: { $gte: internalQty } },
        { $inc: { qty: -internalQty } },
        { new: true }
      );
      if (!updated) {
        for (const s of settled) {
          await Product.updateOne({ _id: s.product._id }, { $inc: { qty: s.internalQty } });
          await reverseBreakdown(s.breakdown);
        }
        const fresh = await Product.findById(product._id);
        return res.status(400).json({ message: `Only ${fresh.qty} ${line.unitLabel} available in stock.` });
      }

      const breakdown = await allocateFefo(product, internalQty);
      if (!breakdown) {
        // Product-level total said there was enough, but the batch records
        // disagree (data drift) - undo this line and everything before it.
        await Product.updateOne({ _id: product._id }, { $inc: { qty: internalQty } });
        for (const s of settled) {
          await Product.updateOne({ _id: s.product._id }, { $inc: { qty: s.internalQty } });
          await reverseBreakdown(s.breakdown);
        }
        return res.status(500).json({ message: "Something went wrong. Please try again." });
      }

      line.internalQtyDeducted = internalQty;
      line.costAmount = Number(breakdown.reduce((sum, b) => sum + b.qty * b.costPricePerUnit, 0).toFixed(2));
      line.batchBreakdown = breakdown;

      settled.push({ product, internalQty, breakdown, line });
    }

    const isDiscountAllowed = isAdmin;
    const appliedDiscount = isDiscountAllowed ? Number(discount) || 0 : 0;

    const subtotal = Number(resolved.reduce((s, r) => s + r.line.amount, 0).toFixed(2));
    const gstAmount = Number(resolved.reduce((s, r) => s + r.line.gstAmount, 0).toFixed(2));
    const total = Number((subtotal + gstAmount - appliedDiscount).toFixed(2));

    let customerId = null;
    if (customer) {
      const customerDoc = typeof customer === "string" ? await Customer.findById(customer) : null;
      customerId = customerDoc ? customerDoc._id : null;
    }

    const billNo = await generateBillNo();
    const sale = await Sale.create({
      billNo,
      customer: customerId,
      items: resolved.map((r) => r.line),
      subtotal,
      gstAmount,
      discount: appliedDiscount,
      total,
      paymentMode: paymentMode || "Cash",
      createdBy: req.user._id,
    });

    for (const { line } of resolved) {
      for (const b of line.batchBreakdown) {
        await StockLedger.create({
          product: line.product,
          batch: b.batch,
          type: "sale",
          qtyChange: -b.qty,
          reason: `Sale ${billNo}`,
          refId: sale._id,
          performedBy: req.user._id,
        });
      }
    }

    const populated = await sale.populate("customer", "name phone");
    res.status(201).json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

router.post("/:id/void", requireRole("admin"), async (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ message: "This field is required." });

  const sale = await Sale.findById(req.params.id).populate("customer", "name phone").populate("createdBy", "username");
  if (!sale) return res.status(404).json({ message: "No records found." });
  if (sale.paymentStatus === "void") {
    return res.status(400).json({ message: "This bill has already been voided." });
  }

  for (const item of sale.items) {
    await Product.updateOne({ _id: item.product }, { $inc: { qty: item.internalQtyDeducted } });

    if (item.batchBreakdown && item.batchBreakdown.length > 0) {
      await reverseBreakdown(item.batchBreakdown);
      for (const b of item.batchBreakdown) {
        await StockLedger.create({
          product: item.product,
          batch: b.batch,
          type: "void-reversal",
          qtyChange: b.qty,
          reason: `Void of ${sale.billNo}: ${reason.trim()}`,
          refId: sale._id,
          performedBy: req.user._id,
        });
      }
    } else {
      // Sold before batch tracking existed - no per-batch breakdown to restore.
      const product = await Product.findById(item.product);
      const batch = await landLegacyReturn(product, item.internalQtyDeducted, item);
      await StockLedger.create({
        product: item.product,
        batch: batch._id,
        type: "void-reversal",
        qtyChange: item.internalQtyDeducted,
        reason: `Void of ${sale.billNo}: ${reason.trim()} (pre-batch-tracking sale, returned to batch ${batch.batchNo})`,
        refId: sale._id,
        performedBy: req.user._id,
      });
    }
  }

  sale.paymentStatus = "void";
  sale.voidReason = reason.trim();
  sale.voidedBy = req.user._id;
  sale.voidedAt = new Date();
  await sale.save();

  res.json({ ...sale.toObject(), billText: buildBillText(sale) });
});

export default router;
