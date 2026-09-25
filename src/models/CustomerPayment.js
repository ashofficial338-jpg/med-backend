import mongoose from "mongoose";

const customerPaymentSchema = new mongoose.Schema(
  {
    paymentNo: { type: String, required: true, unique: true },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    // Which Credit sale this payment was applied against, if any - null means
    // it was recorded on-account and auto-allocated across open bills.
    sale: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sale",
      default: null,
    },
    amount: { type: Number, required: true, min: 0.01 },
    mode: {
      type: String,
      enum: ["Cash", "Card", "UPI", "Other"],
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

export default mongoose.model("CustomerPayment", customerPaymentSchema);
