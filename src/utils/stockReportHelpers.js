import Product from "../models/Product.js";
import Batch from "../models/Batch.js";

function stockDisplay(product) {
  if (product.soldAs === "pack-and-loose" && product.unitsPerPack) {
    const packs = Math.floor(product.qty / product.unitsPerPack);
    const loose = product.qty % product.unitsPerPack;
    return `${packs} ${product.packUnit}${packs === 1 ? "" : "s"}${loose ? ` + ${loose} ${product.looseUnitName}${loose === 1 ? "" : "s"}` : ""}`;
  }
  return `${product.qty} ${product.packUnit}${product.qty === 1 ? "" : "s"}`;
}

// Per-product stock valuation, at cost (Σ each batch's remaining qty × its
// cost-per-internal-unit - same math already used in products.js's
// stock-clearance route) and at MRP (qty on hand × the effective selling
// rate). Returns totals across the filtered set for a report header/dashboard tile.
export async function buildStockReport({ category, availability } = {}) {
  const filter = { isActive: true };
  if (category) filter.category = category;
  if (availability === "available") filter.qty = { $gt: 0 };
  if (availability === "out") filter.qty = { $lte: 0 };

  let products = await Product.find(filter).populate("category", "name").sort({ name: 1 });
  if (availability === "low") {
    products = products.filter((p) => p.qty > 0 && p.qty <= p.lowStockThreshold);
  }

  const batches = await Batch.find({ product: { $in: products.map((p) => p._id) }, qtyRemaining: { $gt: 0 } });
  const batchesByProduct = new Map();
  for (const b of batches) {
    const key = String(b.product);
    if (!batchesByProduct.has(key)) batchesByProduct.set(key, []);
    batchesByProduct.get(key).push(b);
  }

  let totalValueCost = 0;
  let totalValueMrp = 0;

  const rows = products.map((product) => {
    const productBatches = batchesByProduct.get(String(product._id)) || [];
    const costPerUnit = (batch) =>
      product.soldAs === "pack-and-loose" ? batch.costPrice / product.unitsPerPack : batch.costPrice;
    const valueCost = Number(productBatches.reduce((sum, b) => sum + b.qtyRemaining * costPerUnit(b), 0).toFixed(2));

    const effectiveRate = product.soldAs === "pack-and-loose" ? product.looseRate : product.packRate;
    const valueMrp = Number((product.qty * effectiveRate).toFixed(2));

    const nearestExpiry = productBatches.reduce((min, b) => (!min || b.expiryDate < min ? b.expiryDate : min), null);

    totalValueCost += valueCost;
    totalValueMrp += valueMrp;

    return {
      productId: product._id,
      name: product.name,
      productCode: product.productCode,
      category: product.category?.name || "Uncategorized",
      qtyDisplay: stockDisplay(product),
      isLowStock: product.qty > 0 && product.qty <= product.lowStockThreshold,
      isOut: product.qty <= 0,
      nearestExpiry,
      valueCost,
      valueMrp,
    };
  });

  return {
    rows,
    totals: {
      skuCount: rows.length,
      totalValueCost: Number(totalValueCost.toFixed(2)),
      totalValueMrp: Number(totalValueMrp.toFixed(2)),
    },
  };
}
