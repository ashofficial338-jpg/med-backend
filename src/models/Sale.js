import mongoose from "mongoose";

const saleItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    name: { type: String, required: true }, // snapshot, in case the product is later renamed/deactivated
    unitType: {
      type: String,
      enum: ["pack", "loose"],
      required: true,
    },
    unitLabel: { type: String, required: true }, // e.g. "Strip" or "Tablet", snapshot for the printed bill
    qty: { type: Number, required: true, min: 1 },
    rate: { type: Number, required: true }, // snapshot of packRate/looseRate at sale time
    gstPercent: { type: Number, required: true }, // snapshot
    amount: { type: Number, required: true }, // qty * rate
    gstAmount: { type: Number, required: true },
    internalQtyDeducted: { type: Number, required: true }, // exact stock units taken, sum of batchBreakdown qtys
    costAmount: { type: Number, required: true }, // cost basis for this line at sale time, sum of batchBreakdown costs
    // Which batch(es) this line's stock actually came from (FEFO can split a
    // line across more than one lot) - void reversal restores exactly these,
    // and costAmount above is the sum of qty * costPricePerUnit across these.
    batchBreakdown: [
      {
        batch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", required: true },
        qty: { type: Number, required: true },
        costPricePerUnit: { type: Number, required: true },
        _id: false,
      },
    ],
  },
  { _id: false }
);

const saleSchema = new mongoose.Schema(
  {
    billNo: {
      type: String,
      required: true,
      unique: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },
    items: {
      type: [saleItemSchema],
      validate: (v) => Array.isArray(v) && v.length > 0,
    },
    subtotal: { type: Number, required: true },
    gstAmount: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentStatus: {
      type: String,
      enum: ["completed", "void"],
      default: "completed",
    },
    paymentMode: {
      type: String,
      enum: ["Cash", "Card", "UPI", "Other"],
      default: "Cash",
    },
    voidReason: { type: String, default: "" },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    voidedAt: { type: Date, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Sale", saleSchema);
