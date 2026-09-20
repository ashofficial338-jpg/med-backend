import mongoose from "mongoose";

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model("Counter", counterSchema);

// $inc on a brand-new (upserted) doc starts from 0 regardless of the schema
// default above - Mongoose defaults don't apply to atomic update operators -
// so nextSequence always returns 1, 2, 3, ... and callers offset from there.
export async function nextSequence(name) {
  const counter = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

export default Counter;
