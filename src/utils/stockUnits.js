// Converts a quantity entered in Pack units (plus optional loose extra) into
// the product's internal stock unit - loose units when soldAs is
// 'pack-and-loose' (e.g. 10 Strips x 15 Tablets/Strip = 150), or whole packs
// otherwise. Shared by Products (manual qty entry) and Purchases (stock-in)
// so both convert identically.
export function computeInternalQty({ soldAs, unitsPerPack, qtyPacks, qtyLooseExtra }) {
  const packs = Number(qtyPacks) || 0;
  if (soldAs === "pack-and-loose") {
    return packs * Number(unitsPerPack) + (Number(qtyLooseExtra) || 0);
  }
  return packs;
}
