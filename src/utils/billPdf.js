import PDFDocument from "pdfkit";
import { billTaxBreakup } from "./saleHelpers.js";

// Generates the printable bill PDF from a stored Sale document. Since this is
// a pure function of the immutable Sale record (never regenerated from live
// product prices), a reprint from Bill History is always identical to the
// original - see the FRD's Printing System notes.
//
// Layout mirrors the shop's previous billing software's printed format:
// a Qty/Product Name/Mfr/MRP/Batch/Loc/Exp/GST/Amount table and a
// Gross Total / Discount% / Base / CGST / SGST / Rounded Off footer.
// Mfr, Loc, Dr. and SMAN have no source of data in this system yet, so
// they're printed as blank columns/lines rather than omitted.

// TODO: replace with the real registered business name, GSTIN and address.
const SHOP = {
  name: "GHM Medical Shop",
  gstin: "",
  address: "",
};

function formatDateTime(date) {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${dd}/${mm}/${yy} / ${String(hours).padStart(2, "0")}:${minutes} ${ampm}`;
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

const COLS = [
  { key: "qty", label: "Qty", x: 30, width: 24 },
  { key: "name", label: "Product Name", x: 56, width: 100 },
  { key: "mfr", label: "Mfr", x: 158, width: 28 },
  { key: "mrp", label: "MRP", x: 188, width: 34 },
  { key: "batch", label: "Batch", x: 224, width: 34 },
  { key: "loc", label: "Loc", x: 260, width: 22 },
  { key: "exp", label: "Exp", x: 284, width: 32 },
  { key: "gst", label: "GST", x: 318, width: 24 },
  { key: "amount", label: "Amount", x: 344, width: 66 },
];
const TABLE_RIGHT_EDGE = 410;

export function streamBillPdf(sale, res) {
  const doc = new PDFDocument({ size: "A5", margin: 30 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=${sale.billNo}.pdf`);
  // Without this, browsers can serve a stale cached PDF for the same bill
  // URL (e.g. re-printing the same bill during testing) instead of hitting
  // this handler again.
  res.setHeader("Cache-Control", "no-store");
  doc.pipe(res);

  doc.fillColor("#133331");
  doc.fontSize(13).font("Helvetica-Bold").text(SHOP.name, { align: "center" });
  doc.font("Helvetica").fontSize(8);
  if (SHOP.gstin) doc.text(`GSTIN: ${SHOP.gstin}`, { align: "center" });
  if (SHOP.address) doc.text(SHOP.address, { align: "center" });
  doc.moveDown(0.4);

  doc.fontSize(9);
  doc.text(`NO TAX Bill : ${sale.billNo}`);

  if (sale.paymentStatus === "void") {
    doc.fontSize(14).fillColor("#C4423A").text("VOID", { align: "center" });
    doc.fillColor("#133331").fontSize(9);
  }

  doc.text(`Date: ${formatDateTime(sale.createdAt)}`);
  doc.text(`Name: ${sale.customer?.name || "Walk-in"}`);
  doc.text(`Dr.:`);
  doc.text(`Cus Phone: ${sale.customer?.phone || ""}`);
  doc.moveDown(0.4);

  const drawRule = () => {
    doc.moveTo(30, doc.y).lineTo(TABLE_RIGHT_EDGE, doc.y).strokeColor("#DCEAE8").stroke();
    doc.moveDown(0.3);
  };

  doc.font("Helvetica-Bold").fontSize(7.5);
  const headerY = doc.y;
  COLS.forEach((col) => doc.text(col.label, col.x, headerY, { width: col.width }));
  doc.y = headerY;
  doc.moveDown(1);
  doc.font("Helvetica");
  drawRule();

  sale.items.forEach((item) => {
    const rowY = doc.y;
    const values = {
      qty: `${item.qty} ${item.unitLabel}`,
      name: item.name,
      mfr: "",
      mrp: item.rate.toFixed(2),
      batch: itemBatchLabel(item),
      loc: "",
      exp: itemExpiryLabel(item),
      gst: `${item.gstPercent}%`,
      amount: (item.amount + item.gstAmount).toFixed(2),
    };
    doc.fontSize(7.5);
    COLS.forEach((col) => doc.text(values[col.key], col.x, rowY, { width: col.width }));
    doc.y = rowY;
    doc.moveDown(1);
  });

  drawRule();
  doc.moveDown(0.2);

  const breakup = billTaxBreakup(sale);
  const footerLine = (label, value) => {
    doc.fontSize(9).text(`${label}: ${value}`, 30, doc.y, { width: TABLE_RIGHT_EDGE - 30, align: "right" });
  };

  footerLine("Gross Total", breakup.grossTotal.toFixed(2));
  if (sale.discount > 0) footerLine(`Discount ${breakup.discountPercent.toFixed(2)}% `, sale.discount.toFixed(2));
  footerLine("Base", breakup.base.toFixed(2));
  footerLine("CGST", breakup.cgst.toFixed(2));
  footerLine("SGST", breakup.sgst.toFixed(2));
  doc.font("Helvetica-Bold");
  footerLine("Rounded Off to Rs", breakup.roundedOff.toFixed(2));
  doc.font("Helvetica");

  if (sale.paymentStatus === "void") {
    doc.moveDown();
    doc.fillColor("#C4423A").text(`Voided: ${sale.voidReason}`, { align: "left" });
    doc.fillColor("#133331");
  }

  doc.moveDown(1);
  doc.fontSize(9).text(`Billed By: ${sale.createdBy?.username || ""}`);
  doc.text(`SMAN:`);

  doc.moveDown(1);
  doc.fontSize(8).fillColor("#5B7A77");
  doc.text("Goods Once Sold Can't be Taken Back", { align: "center" });
  doc.text("** PRODUCTS HAVE NO DISCOUNT", { align: "center" });

  doc.end();
}
