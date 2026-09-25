import mongoose from "mongoose";

const supplierPaymentSchema = new mongoose.Schema(
  {
    paymentNo: { type: String, required: true, unique: true },
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      required: true,
    },
    // Which purchase invoice this payment was applied against, if any - null
    // means it was recorded on-account and auto-allocated across open invoices.
    purchase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      default: null,
    },
    amount: { type: Number, required: true, min: 0.01 },
    mode: {
      type: String,
      enum: ["Cash", "Bank Transfer", "Cheque", "UPI", "Other"],
      default: "Cash",
    },
    date: { type: Date, default: Date.now },
    note: { type: String, trim: true, default: "" },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("SupplierPayment", supplierPaymentSchema);
