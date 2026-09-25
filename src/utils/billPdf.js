import PDFDocument from "pdfkit";
import { buildBillText } from "./saleHelpers.js";

// Generates the printable bill PDF from a stored Sale document. Since this is
// a pure function of the immutable Sale record (never regenerated from live
// product prices), a reprint from Bill History is always identical to the
// original - see the FRD's Printing System notes.
//
// The bill's actual content/layout comes from buildBillText() (a 100-char
// wide, fixed-width plain-text block) - this just prints that text in a
// monospace font so every column stays aligned. A4 (not A5) because at a
// legible font size, 100 characters needs more width than A5 has.
export function streamBillPdf(sale, res) {
  const doc = new PDFDocument({ size: "A4", margin: 30 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=${sale.billNo}.pdf`);
  // Without this, browsers can serve a stale cached PDF for the same bill
  // URL (e.g. re-printing the same bill during testing) instead of hitting
  // this handler again.
  res.setHeader("Cache-Control", "no-store");
  doc.pipe(res);

  doc.font("Courier").fontSize(8).fillColor("#133331");
  doc.text(buildBillText(sale), { lineGap: 1 });

  doc.end();
}
