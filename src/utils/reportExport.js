import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";

// Generic multi-sheet Excel writer - sheets: [{ name, columns: [{header,key,width}], rows }].
// Extracted from what dashboard.js's export route used to build inline.
export async function streamExcelReport(res, filename, sheets) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name);
    ws.columns = sheet.columns;
    ws.addRows(sheet.rows);
  }
  await workbook.xlsx.write(res);
  res.end();
}

// Generic single-table PDF - a plain positioned-text table (not the
// fixed-width monospace block saleHelpers.buildBillText uses for the printed
// bill; column counts vary per report here, so cells are laid out by x/y
// position instead), paginating automatically as rows run off the page.
export function streamPdfReport(res, filename, { title, subtitle, columns, rows, summaryLines }) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

  const doc = new PDFDocument({ size: "A4", margin: 36, layout: columns.length > 6 ? "landscape" : "portrait" });
  doc.pipe(res);

  doc.font("Helvetica-Bold").fontSize(16).fillColor("#133331").text(title);
  if (subtitle) {
    doc.font("Helvetica").fontSize(10).fillColor("#5B7A77").text(subtitle);
  }
  doc.moveDown(0.5);

  if (summaryLines?.length) {
    doc.font("Helvetica").fontSize(10).fillColor("#133331");
    summaryLines.forEach((line) => doc.text(line));
    doc.moveDown(0.5);
  }

  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / columns.length;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  function drawHeader() {
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#133331");
    columns.forEach((c, i) => {
      doc.text(c.header, startX + i * colWidth, y, { width: colWidth - 4, align: c.align || "left" });
    });
    doc.moveDown(0.4);
    doc.moveTo(startX, doc.y).lineTo(startX + usableWidth, doc.y).strokeColor("#c3c2b7").stroke();
    doc.moveDown(0.3);
  }

  drawHeader();

  doc.font("Helvetica").fontSize(9).fillColor("#133331");
  for (const row of rows) {
    if (doc.y > bottomLimit - 20) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    columns.forEach((c, i) => {
      doc.text(String(row[c.key] ?? ""), startX + i * colWidth, y, { width: colWidth - 4, align: c.align || "left" });
    });
    doc.moveDown(0.4);
  }

  if (rows.length === 0) {
    doc.font("Helvetica").fontSize(10).fillColor("#5B7A77").text("No records found.");
  }

  doc.end();
}
