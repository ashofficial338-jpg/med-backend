// One-time migration: before this change, Product carried a single
// batchNo/expiryDate/costPrice directly (overwritten on every purchase).
// Those fields are gone from the schema now, but existing documents still
// have them as raw data in Mongo. This creates one Batch per existing
// product from whatever legacy batch data is still sitting there, so
// current stock doesn't silently become unsellable (no batch = FEFO finds
// nothing = every sale on that product fails).
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Product from "../models/Product.js";
import Batch from "../models/Batch.js";

async function migrate() {
  await connectDB();

  const products = await mongoose.connection.collection("products").find({}).toArray();
  let created = 0;
  let skipped = 0;

  for (const p of products) {
    const existingBatch = await Batch.findOne({ product: p._id });
    if (existingBatch) {
      skipped++;
      continue;
    }
    if (!(p.qty > 0)) {
      skipped++;
      continue;
    }
    if (!p.batchNo || !p.expiryDate) {
      console.warn(`Skipping ${p.name} (${p._id}) - qty ${p.qty} but no legacy batch data found.`);
      skipped++;
      continue;
    }

    await Batch.create({
      product: p._id,
      batchNo: p.batchNo,
      expiryDate: p.expiryDate,
      costPrice: p.costPrice || 0,
      qtyReceived: p.qty,
      qtyRemaining: p.qty,
      receivedAt: p.updatedAt || p.createdAt || new Date(),
    });
    created++;
    console.log(`Created opening batch for ${p.name}: ${p.batchNo}, qty ${p.qty}`);
  }

  // Drop the now-unused legacy fields so raw DB reads aren't confusing.
  await mongoose.connection.collection("products").updateMany(
    {},
    { $unset: { batchNo: "", expiryDate: "", costPrice: "" } }
  );

  console.log(`\nMigration done. Batches created: ${created}, skipped: ${skipped}.`);
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
