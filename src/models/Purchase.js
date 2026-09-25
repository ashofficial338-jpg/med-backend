import mongoose from "mongoose";

const purchaseItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    qtyPacks: {
      type: Number,
      required: true,
      min: 1,
    },
    costPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    batchNo: {
      type: String,
      required: true,
      trim: true,
    },
    expiryDate: {
      type: Date,
      required: true,
    },
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      default: null,
    },
    lineAmount: {
      type: Number,
      required: true,
    },
    lineGst: {
      type: Number,
      required: true,
    },
  },
  { _id: false }
);

const purchaseSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      required: true,
    },
    invoiceNo: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: Date,
      required: true,
    },
    items: {
      type: [purchaseItemSchema],
      validate: (v) => Array.isArray(v) && v.length > 0,
    },
    subtotal: { type: Number, required: true },
    gstAmount: { type: Number, required: true },
    tdsAmount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentMode: {
      type: String,
      enum: ["Cash", "Bank Transfer", "Cheque", "UPI", "Credit", "Other"],
      default: "Credit",
    },
    // Only ever mutated by creating a SupplierPayment (see ledgerHelpers.js) -
    // never edited directly, so the sum of payments always matches this field.
    amountPaid: { type: Number, required: true, default: 0 },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

purchaseSchema.index({ vendor: 1, invoiceNo: 1 }, { unique: true });

// Purchases recorded before this field existed have no amountPaid - treat
// them as fully paid rather than manufacturing historical payables out of nowhere.
purchaseSchema.virtual("balanceDue").get(function () {
  const paid = this.amountPaid ?? this.total;
  return Number((this.total - paid).toFixed(2));
});

export default mongoose.model("Purchase", purchaseSchema);
