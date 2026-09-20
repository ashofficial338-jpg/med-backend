import { nextSequence } from "../models/Counter.js";

// A "pack" line always deducts unitsPerPack loose units for a pack-and-loose
// product (or 1 pack for a pack-only product); a "loose" line deducts exactly
// the loose qty. Mirrors the Pack/Loose design from the Products module.
export function saleLineInternalQty(product, unitType, qty) {
  if (unitType === "pack") {
    return product.soldAs === "pack-and-loose" ? qty * product.unitsPerPack : qty;
  }
  return qty; // loose
}

export async function generateBillNo() {
  const seq = await nextSequence("billNo");
  return `GHM-${String(seq).padStart(6, "0")}`;
}
