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

// Splits a sale's stored totals into the printed bill's tax breakup: Gross
// Total (pre-discount, tax-inclusive), Base (post-discount taxable value) and
// an even CGST/SGST split of the post-discount tax. Discount is applied to
// the whole bill (not per-line), so the post-discount tax split assumes a
// uniform GST rate across the bill - the weighted average of the sale's
// actual per-line rates - which is exact for a single-rate bill and a close
// approximation otherwise.
export function billTaxBreakup(sale) {
  const grossTotal = Number((sale.subtotal + sale.gstAmount).toFixed(2));
  const discountPercent = grossTotal > 0 ? (sale.discount / grossTotal) * 100 : 0;
  const postDiscountTotal = Number((sale.subtotal + sale.gstAmount - sale.discount).toFixed(2));
  const avgGstRate = sale.subtotal > 0 ? sale.gstAmount / sale.subtotal : 0;
  const base = Number((postDiscountTotal / (1 + avgGstRate)).toFixed(2));
  const gstAfterDiscount = Number((postDiscountTotal - base).toFixed(2));
  const cgst = Number((gstAfterDiscount / 2).toFixed(2));
  const sgst = Number((gstAfterDiscount / 2).toFixed(2));
  const roundedOff = Math.round(postDiscountTotal);

  return { grossTotal, discountPercent, base, cgst, sgst, roundedOff };
}
