import mongoose from "mongoose";

// One row per physical lot/delivery of a product. Replaces the old single
// batchNo/expiryDate/costPrice fields that used to live directly on Product
// (which got silently overwritten every time a new purchase came in for the
// same product - losing the older, still-on-shelf batch's expiry entirely).
// qtyReceived is the immutable original amount; qtyRemaining is what's still
// on hand from this specific lot and is what sales/adjustments/clearance deduct.
const batchSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    batchNo: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
    },
    expiryDate: {
      type: Date,
      required: true,
    },
    costPrice: {
      type: Number,
      required: true,
      min: 0, // per Pack Unit, for this lot specifically
    },
    qtyReceived: {
      type: Number,
      required: true,
      min: 0,
    },
    qtyRemaining: {
      type: Number,
      required: true,
      min: 0,
    },
    receivedAt: {
      type: Date,
      required: true,
    },
    purchase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      default: null,
    },
  },
  { timestamps: true }
);

batchSchema.index({ product: 1, batchNo: 1 }, { unique: true });
batchSchema.index({ product: 1, qtyRemaining: 1, expiryDate: 1 });

export default mongoose.model("Batch", batchSchema);
