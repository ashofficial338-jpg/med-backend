import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import Product from "../models/Product.js";
import Batch from "../models/Batch.js";
import StockLedger from "../models/StockLedger.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { uploadProductImage, uploadedImageUrl } from "../middleware/upload.js";
import { generateProductCode, resolveCategory, computeLooseRate, deriveSoldAs } from "../utils/productHelpers.js";
import { computeInternalQty as computeQty } from "../utils/stockUnits.js";
import { upsertBatch } from "../utils/batchHelpers.js";

const router = Router();
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const PACK_UNITS = ["Strip", "Bottle", "Box", "Tube", "Vial", "Jar", "Piece"];
const LOOSE_UNITS = ["Tablet", "Capsule", "ml", "Piece"];
const GST_VALUES = [0, 5, 12, 18, 28];

function stripCostPriceIfStaff(product, role) {
  const obj = product.toObject ? product.toObject() : product;
  if (role === "staff") delete obj.costPrice;
  return obj;
}

function availabilityFilter(filter, availability) {
  if (availability === "available") filter.qty = { $gt: 0 };
  if (availability === "out") filter.qty = { $lte: 0 };
  // "low" is computed post-query since it depends on a per-doc threshold comparison
}

// Attaches nearestExpiry (earliest active batch) and batchCount to each
// product, for tile/list display - a product can now have several lots on
// the shelf at once, so there's no single "the" expiry date to show anymore.
async function withBatchSummary(products) {
  const ids = products.map((p) => p._id);
  const rows = await Batch.aggregate([
    { $match: { product: { $in: ids }, qtyRemaining: { $gt: 0 } } },
    { $group: { _id: "$product", nearestExpiry: { $min: "$expiryDate" }, batchCount: { $sum: 1 } } },
  ]);
  const byProduct = new Map(rows.map((r) => [String(r._id), r]));
  return products.map((p) => {
    const obj = p.toObject ? p.toObject() : p;
    const summary = byProduct.get(String(obj._id));
    obj.nearestExpiry = summary?.nearestExpiry || null;
    obj.batchCount = summary?.batchCount || 0;
    return obj;
  });
}

router.get("/", requireAuth, async (req, res) => {
  const { q, category, availability, vendor } = req.query;
  const filter = { isActive: true };

  if (q) {
    filter.$or = [{ name: new RegExp(q, "i") }, { productCode: new RegExp(q, "i") }];
  }
  if (category) filter.category = category;
  if (vendor) filter.vendor = vendor;
  availabilityFilter(filter, availability);

  let products = await Product.find(filter).populate("category", "name").populate("vendor", "name").sort({ createdAt: -1 });

  if (availability === "low") {
    products = products.filter((p) => p.qty > 0 && p.qty <= p.lowStockThreshold);
  }

  const withBatches = await withBatchSummary(products);
  res.json(withBatches.map((p) => stripCostPriceIfStaff(p, req.user.role)));
});

// Registered before GET "/:id" - both are single-segment GET routes, and Express
// matches in registration order, so this must come first or "/:id" would treat
// "expiry-tracker" as an id.
const EXPIRING_SOON_WINDOW_DAYS = 30;

router.get("/expiry-tracker", requireAuth, requireRole("admin"), async (req, res) => {
  const now = new Date();
  const soonCutoff = new Date(now.getTime() + EXPIRING_SOON_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const batches = await Batch.find({ qtyRemaining: { $gt: 0 } })
    .populate({ path: "product", select: "name productCode isActive", match: { isActive: true } })
    .sort({ expiryDate: 1 });

  const expired = [];
  const expiringSoon = [];
  const ok = [];

  for (const b of batches) {
    if (!b.product) continue; // product deactivated since - skip from the tracker
    if (b.expiryDate < now) expired.push(b);
    else if (b.expiryDate <= soonCutoff) expiringSoon.push(b);
    else ok.push(b);
  }

  res.json({ expired, expiringSoon, ok, windowDays: EXPIRING_SOON_WINDOW_DAYS });
});

router.post("/stock-clearance", requireAuth, requireRole("admin"), async (req, res) => {
  const { batchIds } = req.body;
  if (!Array.isArray(batchIds) || batchIds.length === 0) {
    return res.status(400).json({ message: "Please select at least one item." });
  }

  const cleared = [];
  for (const id of batchIds) {
    const batch = await Batch.findById(id).populate("product");
    if (!batch || !batch.product || batch.qtyRemaining <= 0) continue;

    const product = batch.product;
    const qtyWrittenOff = batch.qtyRemaining;
    const costPerUnit = product.soldAs === "pack-and-loose" ? batch.costPrice / product.unitsPerPack : batch.costPrice;
    const costImpact = Number((qtyWrittenOff * costPerUnit).toFixed(2));

    await StockLedger.create({
      product: product._id,
      batch: batch._id,
      type: "stock-clearance",
      qtyChange: -qtyWrittenOff,
      reason: "Expired - written off",
      performedBy: req.user._id,
      costImpact,
    });

    batch.qtyRemaining = 0;
    await batch.save();
    await Product.updateOne({ _id: product._id }, { $inc: { qty: -qtyWrittenOff } });

    cleared.push({ batchId: batch._id, productName: product.name, batchNo: batch.batchNo, qtyWrittenOff, costImpact });
  }

  res.json({ cleared });
});

router.get("/:id", requireAuth, async (req, res) => {
  const product = await Product.findById(req.params.id).populate("category", "name").populate("vendor", "name");
  if (!product) return res.status(404).json({ message: "No records found." });
  res.json(stripCostPriceIfStaff(product, req.user.role));
});

// Full batch breakdown for a product - Batch No / Expiry / Qty Remaining /
// Received Date / Cost - used by the Product Detail panel, Stock Management,
// and the batch pickers in Adjust Stock. Admin-only: cost price is in here.
router.get("/:id/batches", requireAuth, requireRole("admin"), async (req, res) => {
  const batches = await Batch.find({ product: req.params.id, qtyReceived: { $gt: 0 } }).sort({ expiryDate: 1 });
  res.json(batches);
});

router.post("/", requireAuth, requireRole("admin"), (req, res) => {
  uploadProductImage(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });

    try {
      const b = req.body;
      const category = await resolveCategory(b.category);
      if (!category) return res.status(400).json({ message: "This field is required." });

      if (!PACK_UNITS.includes(b.packUnit)) {
        return res.status(400).json({ message: "This field is required." });
      }
      const soldAs = deriveSoldAs(b.unitsPerPack);
      if (soldAs === "pack-and-loose" && !LOOSE_UNITS.includes(b.looseUnitName)) {
        return res.status(400).json({ message: "This field is required." });
      }
      if (!GST_VALUES.includes(Number(b.gstPercent))) {
        return res.status(400).json({ message: "This field is required." });
      }

      const productCode = await generateProductCode(b.name || "");
      const qty = computeQty({ ...b, soldAs });
      const looseRate = computeLooseRate({ soldAs, packRate: b.packRate, unitsPerPack: b.unitsPerPack });

      const product = await Product.create({
        name: b.name,
        productCode,
        category: category._id,
        image: uploadedImageUrl(req.file) || "",
        strengthValue: b.strengthValue || undefined,
        strengthUnit: b.strengthUnit || "",
        soldAs,
        packUnit: b.packUnit,
        unitsPerPack: soldAs === "pack-and-loose" ? b.unitsPerPack : undefined,
        looseUnitName: soldAs === "pack-and-loose" ? b.looseUnitName : "",
        qty,
        packRate: b.packRate,
        looseRate,
        gstPercent: b.gstPercent,
        hsnCode: b.hsnCode || "",
        lowStockThreshold: b.lowStockThreshold ?? 10,
        vendor: b.vendor || null,
      });

      // Opening stock: creates this product's first batch/lot, if any was entered.
      if (qty > 0) {
        if (!b.batchNo || !b.expiryDate || b.costPrice === undefined || b.costPrice === "") {
          await Product.deleteOne({ _id: product._id });
          return res.status(400).json({ message: "This field is required." });
        }
        await upsertBatch({
          product,
          batchNo: b.batchNo,
          expiryDate: b.expiryDate,
          costPrice: b.costPrice,
          addQty: qty,
          receivedAt: new Date(),
        });
      }

      const populated = await product.populate(["category", "vendor"].map((path) => ({ path, select: "name" })));
      res.status(201).json(stripCostPriceIfStaff(populated, "admin"));
    } catch (e) {
      if (e.name === "ValidationError") {
        return res.status(400).json({ message: Object.values(e.errors)[0].message });
      }
      res.status(500).json({ message: "Something went wrong. Please try again." });
    }
  });
});

router.patch("/:id", requireAuth, requireRole("admin"), (req, res) => {
  uploadProductImage(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });

    try {
      const product = await Product.findById(req.params.id);
      if (!product) return res.status(404).json({ message: "No records found." });

      const b = req.body;

      if (b.category) {
        const category = await resolveCategory(b.category);
        if (category) product.category = category._id;
      }
      if (b.vendor !== undefined) {
        product.vendor = b.vendor || null;
      }

      // Batch No / Expiry / Cost Price / Qty are no longer product-level -
      // they're edited via Purchases, Adjust Stock, or Stock Management instead.
      // Units per Pack / Loose Unit Name (and the soldAs they imply) are
      // locked after creation too: Product.qty is already stored in whatever
      // unit that choice implies, so changing it later would silently
      // reinterpret existing stock into the wrong granularity.
      const fields = ["name", "strengthValue", "strengthUnit", "packUnit", "packRate", "gstPercent", "hsnCode", "lowStockThreshold"];
      fields.forEach((f) => {
        if (b[f] !== undefined && b[f] !== "") product[f] = b[f];
      });

      if (product.soldAs === "pack-and-loose") {
        const recomputed = computeLooseRate({
          soldAs: product.soldAs,
          packRate: product.packRate,
          unitsPerPack: product.unitsPerPack,
        });
        if (recomputed !== undefined) product.looseRate = recomputed;
      }

      if (req.file) product.image = uploadedImageUrl(req.file);

      await product.save();
      const populated = await product.populate(["category", "vendor"].map((path) => ({ path, select: "name" })));
      res.json(stripCostPriceIfStaff(populated, "admin"));
    } catch (e) {
      if (e.name === "ValidationError") {
        return res.status(400).json({ message: Object.values(e.errors)[0].message });
      }
      res.status(500).json({ message: "Something went wrong. Please try again." });
    }
  });
});

router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ message: "No records found." });
  product.isActive = false;
  await product.save();
  res.json({ message: "Deactivated." });
});

router.get("/import/template", requireAuth, requireRole("admin"), async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Products");
  sheet.columns = [
    { header: "Name", key: "name", width: 24 },
    { header: "Category", key: "category", width: 18 },
    { header: "Strength Value", key: "strengthValue", width: 14 },
    { header: "Strength Unit (mg/mcg/ml/g)", key: "strengthUnit", width: 18 },
    { header: "Pack Unit (Strip/Bottle/Box/Tube/Vial/Jar/Piece)", key: "packUnit", width: 30 },
    { header: "Units Per Pack (leave blank if not sold loose)", key: "unitsPerPack", width: 30 },
    { header: "Loose Unit Name (Tablet/Capsule/ml/Piece - only if Units Per Pack > 1)", key: "looseUnitName", width: 40 },
    { header: "Qty (Packs)", key: "qtyPacks", width: 14 },
    { header: "Pack Rate", key: "packRate", width: 12 },
    { header: "Cost Price", key: "costPrice", width: 12 },
    { header: "GST % (0/5/12/18/28)", key: "gstPercent", width: 18 },
    { header: "HSN Code", key: "hsnCode", width: 14 },
    { header: "Batch No", key: "batchNo", width: 16 },
    { header: "Expiry Date (YYYY-MM-DD)", key: "expiryDate", width: 20 },
    { header: "Low Stock Threshold", key: "lowStockThreshold", width: 18 },
  ];
  sheet.addRow({
    name: "Dolo 650",
    category: "Tablet",
    strengthValue: 650,
    strengthUnit: "mg",
    packUnit: "Strip",
    unitsPerPack: 15,
    looseUnitName: "Tablet",
    qtyPacks: 10,
    packRate: 32,
    costPrice: 22,
    gstPercent: 12,
    hsnCode: "3004",
    batchNo: "B2024117",
    expiryDate: "2027-06-30",
    lowStockThreshold: 10,
  });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", "attachment; filename=GHM_Product_Import_Template.xlsx");
  await workbook.xlsx.write(res);
  res.end();
});

router.post("/import", requireAuth, requireRole("admin"), importUpload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "This field is required." });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(req.file.buffer);
  const sheet = workbook.worksheets[0];

  const headerRow = sheet.getRow(1).values; // 1-indexed, index 0 empty
  const keyMap = {
    Name: "name",
    Category: "category",
    "Strength Value": "strengthValue",
    "Strength Unit (mg/mcg/ml/g)": "strengthUnit",
    "Pack Unit (Strip/Bottle/Box/Tube/Vial/Jar/Piece)": "packUnit",
    "Units Per Pack (leave blank if not sold loose)": "unitsPerPack",
    "Loose Unit Name (Tablet/Capsule/ml/Piece - only if Units Per Pack > 1)": "looseUnitName",
    "Qty (Packs)": "qtyPacks",
    "Pack Rate": "packRate",
    "Cost Price": "costPrice",
    "GST % (0/5/12/18/28)": "gstPercent",
    "HSN Code": "hsnCode",
    "Batch No": "batchNo",
    "Expiry Date (YYYY-MM-DD)": "expiryDate",
    "Low Stock Threshold": "lowStockThreshold",
  };

  const results = [];

  for (let rowNum = 2; rowNum <= sheet.rowCount; rowNum++) {
    const row = sheet.getRow(rowNum);
    if (row.values.length <= 1) continue; // skip blank rows

    const data = {};
    headerRow.forEach((header, idx) => {
      const key = keyMap[header];
      if (key) data[key] = row.getCell(idx).value;
    });

    try {
      if (!data.name) throw new Error("Name is required.");
      if (!data.category) throw new Error("Category is required.");
      if (!PACK_UNITS.includes(data.packUnit)) throw new Error("Pack Unit is invalid.");
      const soldAs = deriveSoldAs(data.unitsPerPack);
      if (soldAs === "pack-and-loose" && !LOOSE_UNITS.includes(data.looseUnitName)) {
        throw new Error("Loose Unit Name is invalid for a pack-and-loose product.");
      }
      if (!GST_VALUES.includes(Number(data.gstPercent))) throw new Error("GST % is invalid.");
      if (!data.batchNo) throw new Error("Batch No is required.");
      if (!data.expiryDate) throw new Error("Expiry Date is required.");
      if (!data.packRate || Number(data.packRate) <= 0) throw new Error("Pack Rate must be greater than 0.");

      const category = await resolveCategory(String(data.category));

      // Matched by product name alone now (batch-level top-up/creation is
      // handled by upsertBatch below), so a new batch of an existing medicine
      // no longer creates a duplicate product the way name+batch matching used to.
      const existing = await Product.findOne({ name: new RegExp(`^${String(data.name).trim()}$`, "i") });

      const addQty = computeQty({
        soldAs,
        unitsPerPack: data.unitsPerPack,
        qtyPacks: data.qtyPacks,
        qtyLooseExtra: 0,
      });

      if (existing) {
        await upsertBatch({
          product: existing,
          batchNo: data.batchNo,
          expiryDate: data.expiryDate,
          costPrice: data.costPrice || 0,
          addQty,
          receivedAt: new Date(),
        });
        existing.qty += addQty;
        await existing.save();
        results.push({ row: rowNum, name: data.name, status: "success", message: "Stock topped up on existing product." });
      } else {
        const productCode = await generateProductCode(String(data.name));
        const looseRate = computeLooseRate({ soldAs, packRate: data.packRate, unitsPerPack: data.unitsPerPack });
        const created = await Product.create({
          name: data.name,
          productCode,
          category: category._id,
          strengthValue: data.strengthValue || undefined,
          strengthUnit: data.strengthUnit || "",
          soldAs,
          packUnit: data.packUnit,
          unitsPerPack: data.unitsPerPack || undefined,
          looseUnitName: soldAs === "pack-and-loose" ? data.looseUnitName : "",
          qty: addQty,
          packRate: data.packRate,
          looseRate,
          gstPercent: data.gstPercent,
          hsnCode: data.hsnCode || "",
          lowStockThreshold: data.lowStockThreshold ?? 10,
        });
        await upsertBatch({
          product: created,
          batchNo: data.batchNo,
          expiryDate: data.expiryDate,
          costPrice: data.costPrice || 0,
          addQty,
          receivedAt: new Date(),
        });
        results.push({ row: rowNum, name: data.name, status: "success", message: "Product created." });
      }
    } catch (e) {
      results.push({ row: rowNum, name: data.name || "(blank)", status: "failed", message: e.message });
    }
  }

  res.json({ results });
});

export default router;
