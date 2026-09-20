import Category from "../models/Category.js";
import { nextSequence } from "../models/Counter.js";

// Whether a product can be sold loose is never chosen manually - it's
// implied by whether a pack actually breaks into more than one unit. Every
// product is added to stock as whole packs either way (see the Read Me
// sheet); this just decides whether Checkout also offers a loose stepper.
export function deriveSoldAs(unitsPerPack) {
  return Number(unitsPerPack) > 1 ? "pack-and-loose" : "pack-only";
}

// Loose selling price is never entered independently - it's always a
// fraction of the pack price, since stock only ever arrives in packs.
export function computeLooseRate({ soldAs, packRate, unitsPerPack }) {
  if (soldAs !== "pack-and-loose") return undefined;
  const pack = Number(packRate);
  const units = Number(unitsPerPack);
  if (!(pack > 0) || !(units > 0)) return undefined;
  return Number((pack / units).toFixed(2));
}

export async function generateProductCode(name) {
  const letters = (name.match(/[A-Za-z]/g) || []).slice(0, 3).join("").toUpperCase();
  const prefix = letters.padEnd(3, "X");
  const seq = await nextSequence("productCode"); // 1, 2, 3, ... -> offset so codes start at 100
  return `${prefix}${99 + seq}`;
}

// Resolves a category by id (existing) or name (creates it on the spot if new),
// per the FRD: typing a brand-new category in the Add Product form saves it immediately.
export async function resolveCategory(categoryInput) {
  if (!categoryInput) return null;

  if (/^[0-9a-fA-F]{24}$/.test(categoryInput)) {
    const byId = await Category.findById(categoryInput);
    if (byId) return byId;
  }

  const name = String(categoryInput).trim();
  if (!name) return null;

  let category = await Category.findOne({ name: new RegExp(`^${name}$`, "i") });
  if (!category) {
    category = await Category.create({ name });
  }
  return category;
}
