import mongoose from "mongoose";

const expenseSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      enum: ["Rent", "Salary", "Utilities", "Other"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    // Which cash bucket this expense drew from - the Day Book (dayBookHelpers.js)
    // uses this to attribute outflows to Cash/UPI; Card/Other sit outside those
    // tracked buckets, same as on Sale/CustomerPayment/SupplierPayment.
    paymentMode: {
      type: String,
      enum: ["Cash", "UPI", "Card", "Other"],
      default: "Cash",
    },
    date: {
      type: Date,
      required: true,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Expense", expenseSchema);
