import { Router } from "express";
import StockLedger from "../models/StockLedger.js";
import Product from "../models/Product.js";
import Batch from "../models/Batch.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { upsertBatch } from "../utils/batchHelpers.js";

const router = Router();
router.use(requireAuth, requireRole("admin"));

router.get("/", async (req, res) => {
  const { product, type } = req.query;
  const filter = {};
  if (product) filter.product = product;
  if (type) filter.type = type;

  const entries = await StockLedger.find(filter)
    .populate("product", "name productCode")
    .populate("batch", "batchNo expiryDate")
    .populate("performedBy", "username")
    .sort({ createdAt: -1 })
    .limit(200);
  res.json(entries);
});

router.post("/adjust", async (req, res) => {
  const { product: productId, adjustmentType, qty, reason, batchId, batchNo, expiryDate, costPrice } = req.body;

  if (!productId) return res.status(400).json({ message: "This field is required." });
  if (!["add", "reduce"].includes(adjustmentType)) {
    return res.status(400).json({ message: "This field is required." });
  }
  const quantity = Number(qty);
  if (!(quantity > 0)) return res.status(400).json({ message: "Please enter a valid number." });
  if (!reason || !reason.trim()) return res.status(400).json({ message: "This field is required." });

  const product = await Product.findById(productId);
  if (!product) return res.status(404).json({ message: "No records found." });

  let batch;

  if (adjustmentType === "reduce") {
    // Admin picks exactly which lot this came from - breakage/spoilage found
    // on the shelf is almost always traceable to one specific pack.
    if (!batchId) return res.status(400).json({ message: "This field is required." });
    batch = await Batch.findOne({ _id: batchId, product: product._id });
    if (!batch) return res.status(404).json({ message: "No records found." });
    if (quantity > batch.qtyRemaining) {
      return res.status(400).json({ message: "Cannot reduce below available stock." });
    }
    batch.qtyRemaining -= quantity;
    await batch.save();
    product.qty -= quantity;
  } else {
    if (batchId) {
      batch = await Batch.findOne({ _id: batchId, product: product._id });
      if (!batch) return res.status(404).json({ message: "No records found." });
      batch.qtyReceived += quantity;
      batch.qtyRemaining += quantity;
      await batch.save();
    } else {
      if (!batchNo || !expiryDate || costPrice === undefined || costPrice === "") {
        return res.status(400).json({ message: "This field is required." });
      }
      batch = await upsertBatch({
        product,
        batchNo,
        expiryDate,
        costPrice,
        addQty: quantity,
        receivedAt: new Date(),
      });
    }
    product.qty += quantity;
  }

  await product.save();

  const entry = await StockLedger.create({
    product: product._id,
    batch: batch._id,
    type: adjustmentType === "add" ? "manual-add" : "manual-reduce",
    qtyChange: adjustmentType === "add" ? quantity : -quantity,
    reason: reason.trim(),
    performedBy: req.user._id,
  });

  res.status(201).json({ product, entry });
});

export default router;
