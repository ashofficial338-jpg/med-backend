import mongoose from "mongoose";

// A manual reconciliation point, not a day-by-day chain: "as of the end of
// `date`, the true `type` balance was `balance`". dayBookHelpers.js finds the
// latest adjustment at or before a given day and adds up transactions since,
// so a correction never requires seeding every historical day, and a
// backdated transaction elsewhere never desyncs a stored running total.
const dayBookAdjustmentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Cash", "UPI", "Credit"],
      required: true,
    },
    date: { type: Date, required: true },
    balance: { type: Number, required: true },
    note: { type: String, trim: true, default: "" },
    setBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

dayBookAdjustmentSchema.index({ type: 1, date: -1 });

export default mongoose.model("DayBookAdjustment", dayBookAdjustmentSchema);
