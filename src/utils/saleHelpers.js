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
// Total (pre-discount, tax-inclusive), Base (post-discount taxable value),
// an even CGST/SGST split of the post-discount tax, and a per-GST-rate
// breakdown for the "GST SUMMARY" block. Discount is applied to the whole
// bill (not per-line), so it's assumed to shrink every line proportionally -
// each line's post-discount taxable/CGST/SGST is computed from its own GST
// rate, then grouped by rate. This is exact (not an approximation), and
// naturally handles a bill with multiple GST rates in it.
export function billTaxBreakup(sale) {
  const grossTotal = Number((sale.subtotal + sale.gstAmount).toFixed(2));
  const discountPercent = grossTotal > 0 ? (sale.discount / grossTotal) * 100 : 0;
  const postDiscountTotal = Number((sale.subtotal + sale.gstAmount - sale.discount).toFixed(2));
  const scale = grossTotal > 0 ? postDiscountTotal / grossTotal : 1;

  const byRateMap = new Map();
  for (const item of sale.items) {
    const grossLine = (item.amount + item.gstAmount) * scale;
    const taxable = grossLine / (1 + item.gstPercent / 100);
    const gst = grossLine - taxable;
    const entry = byRateMap.get(item.gstPercent) || { rate: item.gstPercent, taxable: 0, cgst: 0, sgst: 0 };
    entry.taxable += taxable;
    entry.cgst += gst / 2;
    entry.sgst += gst / 2;
    byRateMap.set(item.gstPercent, entry);
  }
  const byRate = [...byRateMap.values()]
    .sort((a, b) => a.rate - b.rate)
    .map((r) => ({
      rate: r.rate,
      taxable: Number(r.taxable.toFixed(2)),
      cgst: Number(r.cgst.toFixed(2)),
      sgst: Number(r.sgst.toFixed(2)),
    }));

  const base = Number(byRate.reduce((s, r) => s + r.taxable, 0).toFixed(2));
  const cgst = Number(byRate.reduce((s, r) => s + r.cgst, 0).toFixed(2));
  const sgst = Number(byRate.reduce((s, r) => s + r.sgst, 0).toFixed(2));
  const roundedOff = Math.round(postDiscountTotal);
  const roundOffDelta = Number((roundedOff - postDiscountTotal).toFixed(2));

  return { grossTotal, discountPercent, base, cgst, sgst, postDiscountTotal, roundOffDelta, roundedOff, byRate };
}

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigitWords(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
}
function threeDigitWords(n) {
  if (n >= 100) return `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${twoDigitWords(n % 100)}` : ""}`;
  return twoDigitWords(n);
}

// Indian numbering system (crore/lakh/thousand), whole rupees only - the
// printed bill only ever spells out the rounded net payable amount.
export function numberToWordsIndian(amount) {
  let n = Math.round(amount);
  if (n === 0) return "Zero";

  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const hundred = n;

  const parts = [];
  if (crore) parts.push(`${threeDigitWords(crore)} Crore`);
  if (lakh) parts.push(`${threeDigitWords(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigitWords(thousand)} Thousand`);
  if (hundred) parts.push(threeDigitWords(hundred));

  return parts.join(" ");
}

// TODO: replace with the real registered business name, address, phone,
// GSTIN and Drug License number.
export const SHOP = {
  name: "GHM Medical Shop",
  addressLine1: "",
  addressLine2: "", // e.g. "12 Main Street - Chennai 600001"
  phone: "",
  gstin: "",
  dlNo: "",
};

const W = 100; // total character width of the printed bill

function padEndTo(text, width) {
  text = String(text);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}
function padStartTo(text, width) {
  text = String(text);
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}
function centered(text, width = W) {
  text = String(text);
  const pad = width - text.length;
  if (pad <= 0) return text;
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + text + " ".repeat(pad - left);
}
function field(label, width, value) {
  return `${padEndTo(label, width)}: ${value}`;
}
function twoCol(left, right, split = 50) {
  return padEndTo(left, split) + right;
}

const TABLE_COLS = [
  ["Qty", 6, "L"],
  ["Particulars", 21, "L"],
  ["HSN", 9, "L"],
  ["Mfr", 5, "L"],
  ["Batch", 8, "L"],
  ["Loc", 4, "L"],
  ["Exp", 6, "L"],
  ["MRP", 8, "R"],
  ["Rate", 8, "R"],
  ["GST", 5, "R"],
  ["Amount", 10, "R"],
];

function tableRow(values) {
  return TABLE_COLS.map(([, width, align], i) => {
    const text = String(values[i] ?? "").slice(0, width);
    return align === "L" ? padEndTo(text, width) : padStartTo(text, width);
  }).join(" ");
}

function formatDateOnly(date) {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}
function formatTimeOnly(date) {
  const d = new Date(date);
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${String(hours).padStart(2, "0")}:${minutes} ${ampm}`;
}
function formatExpiry(date) {
  if (!date) return "";
  const d = new Date(date);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${yy}`;
}
function itemBatchLabel(item) {
  if (!item.batchBreakdown || item.batchBreakdown.length === 0) return "";
  return item.batchBreakdown.map((b) => b.batchNo).filter(Boolean).join(",");
}
function itemExpiryLabel(item) {
  if (!item.batchBreakdown || item.batchBreakdown.length === 0) return "";
  // FEFO always draws from the earliest-expiring batch first, so the first
  // entry in the breakdown is the one that expires soonest.
  return formatExpiry(item.batchBreakdown[0].expiryDate);
}

// Builds the full printed bill as fixed-width plain text (100 characters
// wide), so every column lines up exactly under a monospace font - see
// billPdf.js (prints it in Courier) and BillPreview.jsx (renders it in a
// <pre> block). This is the single source of truth for the bill's content;
// both places just display this text rather than re-deriving it.
export function buildBillText(sale) {
  const breakup = billTaxBreakup(sale);
  const HEAVY = "=".repeat(W);
  const LIGHT = "-".repeat(W);
  const lines = [];

  lines.push(HEAVY);
  lines.push(centered(SHOP.name));
  if (SHOP.addressLine1) lines.push(centered(SHOP.addressLine1));
  if (SHOP.addressLine2) lines.push(centered(SHOP.addressLine2));
  const contactBits = [];
  if (SHOP.phone) contactBits.push(`Ph: ${SHOP.phone}`);
  if (SHOP.gstin) contactBits.push(`GSTIN: ${SHOP.gstin}`);
  if (SHOP.dlNo) contactBits.push(`DL No.: ${SHOP.dlNo}`);
  if (contactBits.length) lines.push(centered(contactBits.join("    ")));
  lines.push(HEAVY);

  const billType = sale.paymentStatus === "void" ? "Void Bill" : "No Tax Bill";
  lines.push(twoCol(field("Bill No", 10, sale.billNo), field("Date", 12, formatDateOnly(sale.createdAt))));
  lines.push(twoCol(field("Name", 10, sale.customer?.name || "Walk-in"), field("Time", 12, formatTimeOnly(sale.createdAt))));
  lines.push(twoCol(field("Dr.", 10, ""), field("Bill Type", 12, billType)));
  lines.push(twoCol(field("Cus Phone", 10, sale.customer?.phone || ""), field("Payment Mode", 12, sale.paymentMode)));
  lines.push(LIGHT);

  lines.push(tableRow(TABLE_COLS.map((c) => c[0])));
  lines.push(LIGHT);
  for (const item of sale.items) {
    lines.push(
      tableRow([
        `${item.qty} ${item.unitLabel}`,
        item.name,
        item.hsnCode || "",
        "",
        itemBatchLabel(item),
        "",
        itemExpiryLabel(item),
        item.rate.toFixed(2),
        item.rate.toFixed(2),
        `${item.gstPercent}%`,
        (item.amount + item.gstAmount).toFixed(2),
      ])
    );
  }
  lines.push(LIGHT);

  const SPLIT = 46;
  const summary = [
    "GST SUMMARY",
    `${padEndTo("Rate", 6)}${padStartTo("Taxable", 11)}${padStartTo("CGST", 10)}${padStartTo("SGST", 10)}`,
    `${"-".repeat(6)}${"-".repeat(11)}${"-".repeat(10)}${"-".repeat(10)}`,
    ...breakup.byRate.map(
      (r) =>
        `${padEndTo(`${r.rate}%`, 6)}${padStartTo(r.taxable.toFixed(2), 11)}${padStartTo(r.cgst.toFixed(2), 10)}${padStartTo(r.sgst.toFixed(2), 10)}`
    ),
    "-".repeat(37),
    `${padEndTo("Total", 6)}${padStartTo(breakup.base.toFixed(2), 11)}${padStartTo(breakup.cgst.toFixed(2), 10)}${padStartTo(breakup.sgst.toFixed(2), 10)}`,
    "",
  ];
  const totals = [
    `Gross Total: ${breakup.grossTotal.toFixed(2)}`,
    sale.discount > 0 ? `Discount ${breakup.discountPercent.toFixed(2)}%: ${sale.discount.toFixed(2)}` : "",
    `Taxable Value: ${breakup.base.toFixed(2)}`,
    `CGST: ${breakup.cgst.toFixed(2)}`,
    `SGST: ${breakup.sgst.toFixed(2)}`,
    `Round Off: ${breakup.roundOffDelta >= 0 ? "" : "-"}${Math.abs(breakup.roundOffDelta).toFixed(2)}`,
    "",
    `NET PAYABLE: ${breakup.roundedOff.toFixed(2)}`,
  ];
  for (let i = 0; i < summary.length; i++) {
    lines.push(twoCol(summary[i], totals[i] || "", SPLIT));
  }
  lines.push(HEAVY);

  lines.push(`Amount in Words: ${numberToWordsIndian(breakup.roundedOff)} Rupees Only`);
  lines.push(LIGHT);

  const totalQty = sale.items.reduce((s, i) => s + i.qty, 0);
  lines.push(
    `${padEndTo("Billed By: " + (sale.createdBy?.username || ""), 24)}${padEndTo("SMAN:", 24)}${padEndTo(`Items: ${sale.items.length}`, 16)}Total Qty: ${totalQty}`
  );
  lines.push(LIGHT);

  if (sale.paymentStatus === "void") {
    lines.push(centered(`VOID - ${sale.voidReason}`));
    lines.push("");
  }

  lines.push(centered("Goods Once Sold Can't be Taken Back"));
  lines.push(centered("** PRODUCTS HAVE NO DISCOUNT"));
  lines.push("");
  lines.push(twoCol("Prescription retained", "Authorised Signatory", W - 22));
  lines.push(HEAVY);

  return lines.join("\n");
}
