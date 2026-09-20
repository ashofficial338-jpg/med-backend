import PDFDocument from "pdfkit";

// Generates the printable bill PDF from a stored Sale document. Since this is
// a pure function of the immutable Sale record (never regenerated from live
// product prices), a reprint from Bill History is always identical to the
// original - see the FRD's Printing System notes.
export function streamBillPdf(sale, res) {
  const doc = new PDFDocument({ size: "A5", margin: 30 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=${sale.billNo}.pdf`);
  doc.pipe(res);

  doc.fontSize(18).text("GHM", { align: "center" });
  doc.fontSize(10).fillColor("#5B7A77").text("Medical Shop", { align: "center" });
  doc.moveDown();

  if (sale.paymentStatus === "void") {
    doc.fontSize(20).fillColor("#C4423A").text("VOID", { align: "center" });
    doc.moveDown(0.5);
  }

  doc.fillColor("#133331").fontSize(11);
  doc.text(`Bill No: ${sale.billNo}`);
  doc.text(`Date: ${new Date(sale.createdAt).toLocaleString()}`);
  doc.text(`Customer: ${sale.customer?.name || "Walk-in"}${sale.customer?.phone ? ` (${sale.customer.phone})` : ""}`);
  doc.text(`Payment Mode: ${sale.paymentMode}`);
  doc.moveDown();

  doc.font("Helvetica-Bold");
  doc.text("Item", 30, doc.y, { continued: true, width: 160 });
  doc.text("Qty", 190, doc.y, { continued: true, width: 60 });
  doc.text("Rate", 250, doc.y, { continued: true, width: 60 });
  doc.text("GST", 310, doc.y, { continued: true, width: 50 });
  doc.text("Amount", 360, doc.y);
  doc.font("Helvetica");
  doc.moveDown(0.3);
  doc.moveTo(30, doc.y).lineTo(410, doc.y).strokeColor("#DCEAE8").stroke();
  doc.moveDown(0.3);

  sale.items.forEach((item) => {
    const y = doc.y;
    doc.text(item.name, 30, y, { width: 160 });
    doc.text(`${item.qty} ${item.unitLabel}`, 190, y, { width: 60 });
    doc.text(`Rs ${item.rate.toFixed(2)}`, 250, y, { width: 60 });
    doc.text(`Rs ${item.gstAmount.toFixed(2)}`, 310, y, { width: 50 });
    doc.text(`Rs ${(item.amount + item.gstAmount).toFixed(2)}`, 360, y);
    doc.moveDown(0.4);
  });

  doc.moveDown(0.3);
  doc.moveTo(30, doc.y).lineTo(410, doc.y).strokeColor("#DCEAE8").stroke();
  doc.moveDown(0.5);

  doc.text(`Subtotal: Rs ${sale.subtotal.toFixed(2)}`, { align: "right" });
  doc.text(`GST: Rs ${sale.gstAmount.toFixed(2)}`, { align: "right" });
  if (sale.discount > 0) doc.text(`Discount: -Rs ${sale.discount.toFixed(2)}`, { align: "right" });
  doc.font("Helvetica-Bold").text(`Total: Rs ${sale.total.toFixed(2)}`, { align: "right" });
  doc.font("Helvetica");

  if (sale.paymentStatus === "void") {
    doc.moveDown();
    doc.fillColor("#C4423A").text(`Voided: ${sale.voidReason}`, { align: "left" });
  }

  doc.moveDown(1.5);
  doc.fontSize(9).fillColor("#5B7A77").text("Thank you for your purchase.", { align: "center" });

  doc.end();
}
