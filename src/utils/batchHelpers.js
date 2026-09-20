import Batch from "../models/Batch.js";

// Creates a new lot, or tops up an existing one if this product already has
// a batch with the same batch number (a genuine re-delivery of the same lot).
// addQty is in the product's internal stock unit (loose units for a
// pack-and-loose product, packs otherwise) - same convention as Product.qty.
export async function upsertBatch({ product, batchNo, expiryDate, costPrice, addQty, receivedAt, purchase }) {
  const cleanBatchNo = String(batchNo).trim();
  let batch = await Batch.findOne({ product: product._id, batchNo: cleanBatchNo });

  if (batch) {
    batch.qtyReceived += addQty;
    batch.qtyRemaining += addQty;
    batch.costPrice = costPrice;
    batch.receivedAt = receivedAt || new Date();
    if (purchase) batch.purchase = purchase;
    await batch.save();
  } else {
    batch = await Batch.create({
      product: product._id,
      batchNo: cleanBatchNo,
      expiryDate,
      costPrice,
      qtyReceived: addQty,
      qtyRemaining: addQty,
      receivedAt: receivedAt || new Date(),
      purchase: purchase || null,
    });
  }
  return batch;
}

// First-Expiry-First-Out allocation: deducts `neededQty` internal units from
// this product's active batches, earliest expiry first, splitting across
// batches if one lot doesn't have enough. Each batch decrement is a guarded
// atomic update (race-safe against a concurrent sale touching the same lot);
// if the running total can't be fully covered, whatever was already taken is
// put back and null is returned so the caller can report insufficient stock.
export async function allocateFefo(product, neededQty) {
  const batches = await Batch.find({ product: product._id, qtyRemaining: { $gt: 0 } }).sort({ expiryDate: 1 });

  let remaining = neededQty;
  const breakdown = [];

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.qtyRemaining, remaining);
    if (take <= 0) continue;

    const updated = await Batch.findOneAndUpdate(
      { _id: batch._id, qtyRemaining: { $gte: take } },
      { $inc: { qtyRemaining: -take } },
      { new: true }
    );
    if (!updated) continue; // lost a race on this lot - move on to the next batch

    const costPricePerUnit =
      product.soldAs === "pack-and-loose" ? batch.costPrice / product.unitsPerPack : batch.costPrice;

    breakdown.push({
      batch: batch._id,
      qty: take,
      costPricePerUnit: Number(costPricePerUnit.toFixed(4)),
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate,
    });
    remaining -= take;
  }

  if (remaining > 0) {
    await reverseBreakdown(breakdown);
    return null;
  }
  return breakdown;
}

export async function reverseBreakdown(breakdown) {
  for (const entry of breakdown) {
    await Batch.updateOne({ _id: entry.batch }, { $inc: { qtyRemaining: entry.qty } });
  }
}

// The expiry date this product would actually be sold against next (FEFO
// order) - i.e. the batch that's about to run out first. Null if no stock.
export async function earliestActiveBatch(productId) {
  return Batch.findOne({ product: productId, qtyRemaining: { $gt: 0 } }).sort({ expiryDate: 1 });
}

// A sale recorded before batch tracking existed has no batchBreakdown to
// restore on void. Lands the returned stock back into the product's current
// earliest-expiring batch (so it re-enters the normal FEFO queue), or - if
// every batch has since been fully sold/cleared - reconstructs a placeholder
// lot from the sale line's own cost snapshot, so Product.qty and the sum of
// its batches never silently drift apart.
export async function landLegacyReturn(product, internalQty, item) {
  const existing = await earliestActiveBatch(product._id);
  if (existing) {
    existing.qtyReceived += internalQty;
    existing.qtyRemaining += internalQty;
    await existing.save();
    return existing;
  }

  const costPerInternalUnit = item.internalQtyDeducted > 0 ? item.costAmount / item.internalQtyDeducted : 0;
  const costPrice =
    product.soldAs === "pack-and-loose" ? costPerInternalUnit * product.unitsPerPack : costPerInternalUnit;

  return Batch.create({
    product: product._id,
    batchNo: "LEGACY-RETURN",
    expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    costPrice: Number(costPrice.toFixed(2)),
    qtyReceived: internalQty,
    qtyRemaining: internalQty,
    receivedAt: new Date(),
  });
}
