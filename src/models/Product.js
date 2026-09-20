import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },
    productCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    image: {
      type: String,
      default: "",
    },
    strengthValue: {
      type: Number,
      min: 0,
    },
    strengthUnit: {
      type: String,
      enum: ["mg", "mcg", "ml", "g", ""],
      default: "",
    },
    soldAs: {
      type: String,
      enum: ["pack-only", "pack-and-loose"],
      default: "pack-only",
      required: true,
    },
    packUnit: {
      type: String,
      enum: ["Strip", "Bottle", "Box", "Tube", "Vial", "Jar", "Piece"],
      required: true,
    },
    unitsPerPack: {
      type: Number,
      min: 1,
      required: function () {
        return this.soldAs === "pack-and-loose";
      },
    },
    looseUnitName: {
      type: String,
      enum: ["Tablet", "Capsule", "ml", "Piece", ""],
      default: "",
      required: function () {
        return this.soldAs === "pack-and-loose";
      },
    },
    qty: {
      type: Number,
      default: 0,
      min: 0,
    },
    packRate: {
      type: Number,
      required: true,
      min: 0.01,
    },
    // Always server-computed as packRate / unitsPerPack (rounded to 2dp) - see
    // productHelpers.computeLooseRate. Never accepted as manual input: stock
    // always arrives in packs, so there's no independent "loose cost" to key in.
    looseRate: {
      type: Number,
      min: 0,
      required: function () {
        return this.soldAs === "pack-and-loose";
      },
    },
    gstPercent: {
      type: Number,
      enum: [0, 5, 12, 18, 28],
      required: true,
    },
    hsnCode: {
      type: String,
      trim: true,
      default: "",
    },
    // Batch/lot number, expiry date, and cost price now live on Batch (a
    // product can have several lots on the shelf at once, each with its own
    // expiry and cost) - see server/src/models/Batch.js.
    lowStockThreshold: {
      type: Number,
      default: 10,
      min: 0,
    },
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

productSchema.index({ name: "text", productCode: "text" });

export default mongoose.model("Product", productSchema);
