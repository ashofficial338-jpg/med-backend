import mongoose from "mongoose";

const stockLedgerSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      default: null,
    },
    type: {
      type: String,
      enum: ["purchase", "sale", "manual-add", "manual-reduce", "void-reversal", "stock-clearance"],
      required: true,
    },
    qtyChange: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
      trim: true,
      default: "",
    },
    refId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    costImpact: {
      type: Number,
      default: 0, // ₹ value of the loss, populated for stock-clearance so P&L can show it as its own line
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("StockLedger", stockLedgerSchema);
