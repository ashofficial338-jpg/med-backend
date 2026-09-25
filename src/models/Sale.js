import mongoose from "mongoose";

const saleItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    name: { type: String, required: true }, // snapshot, in case the product is later renamed/deactivated
    hsnCode: { type: String, default: "" }, // snapshot, for the printed bill
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
        // Snapshots for the printed bill, so a reprint never depends on the
        // Batch record still existing/matching later - see billPdf.js.
        batchNo: { type: String, default: "" },
        expiryDate: { type: Date, default: null },
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
      enum: ["Cash", "Card", "UPI", "Other", "Credit"],
      default: "Cash",
    },
    // Only ever mutated by creating a CustomerPayment (see ledgerHelpers.js) -
    // never edited directly, so the sum of payments always matches this field.
    amountPaid: { type: Number, required: true, default: 0 },
    voidReason: { type: String, default: "" },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    voidedAt: { type: Date, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// Sales recorded before this field existed have no amountPaid - treat them as
// fully paid rather than manufacturing historical receivables out of nowhere.
saleSchema.virtual("balanceDue").get(function () {
  const paid = this.amountPaid ?? this.total;
  return Number((this.total - paid).toFixed(2));
});

export default mongoose.model("Sale", saleSchema);
