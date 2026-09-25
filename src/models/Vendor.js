import mongoose from "mongoose";

const vendorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },
    contactPerson: {
      type: String,
      trim: true,
      default: "",
    },
    phone: {
      type: String,
      required: true,
      match: /^\d{10}$/,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    address: {
      type: String,
      trim: true,
      default: "",
    },
    gstNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 15,
      maxlength: 15,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // A single current rating an admin can update anytime - not a review
    // history. Each axis is 1-5; null means "not yet rated".
    ratings: {
      quality: { type: Number, min: 1, max: 5, default: null },
      reliability: { type: Number, min: 1, max: 5, default: null },
      costEfficiency: { type: Number, min: 1, max: 5, default: null },
      ratedAt: { type: Date, default: null },
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

vendorSchema.virtual("overallRating").get(function () {
  const { quality, reliability, costEfficiency } = this.ratings || {};
  const values = [quality, reliability, costEfficiency].filter((v) => v != null);
  if (values.length === 0) return null;
  return Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(1));
});

export default mongoose.model("Vendor", vendorSchema);
