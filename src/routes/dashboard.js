import { Router } from "express";
import ExcelJS from "exceljs";
import Sale from "../models/Sale.js";
import Purchase from "../models/Purchase.js";
import Expense from "../models/Expense.js";
import StockLedger from "../models/StockLedger.js";
import Product from "../models/Product.js";
import Batch from "../models/Batch.js";
import Category from "../models/Category.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("admin"));

function resolveRange(req) {
  const { from, to } = req.query;
  const end = to ? new Date(to) : new Date();
  end.setHours(23, 59, 59, 999);
  const start = from ? new Date(from) : new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

async function computeSummary(start, end) {
  const sales = await Sale.find({
    paymentStatus: "completed",
    createdAt: { $gte: start, $lte: end },
  }).populate("items.product", "category");

  const purchases = await Purchase.find({ date: { $gte: start, $lte: end } });
  const expenses = await Expense.find({ date: { $gte: start, $lte: end } });
  const clearances = await StockLedger.find({
    type: "stock-clearance",
    createdAt: { $gte: start, $lte: end },
  });

  let revenue = 0;
  let cogs = 0;
  let outputGst = 0;
  const productTotals = new Map(); // productId -> { name, totalRevenue }
  const categoryTotals = new Map(); // categoryId -> total
  const dailyTotals = new Map(); // yyyy-mm-dd -> { revenue, expense, profit }

  for (const sale of sales) {
    const netRevenue = sale.subtotal - sale.discount;
    revenue += netRevenue;
    outputGst += sale.gstAmount;

    const day = sale.createdAt.toISOString().slice(0, 10);
    const bucket = dailyTotals.get(day) || { date: day, revenue: 0, expense: 0, profit: 0 };
    bucket.revenue += sale.total;
    dailyTotals.set(day, bucket);

    for (const item of sale.items) {
      cogs += item.costAmount;

      const key = String(item.product?._id || item.product);
      const productBucket = productTotals.get(key) || { name: item.name, totalRevenue: 0 };
      productBucket.totalRevenue += item.amount + item.gstAmount;
      productTotals.set(key, productBucket);

      const catId = item.product?.category ? String(item.product.category) : "uncategorized";
      categoryTotals.set(catId, (categoryTotals.get(catId) || 0) + item.amount);
    }
  }

  const inputGst = purchases.reduce((sum, p) => sum + p.gstAmount, 0);
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const expiredWriteOff = clearances.reduce((sum, c) => sum + (c.costImpact || 0), 0);
  const totalPurchases = purchases.reduce((sum, p) => sum + p.total, 0);

  for (const e of expenses) {
    const day = e.date.toISOString().slice(0, 10);
    const bucket = dailyTotals.get(day) || { date: day, revenue: 0, expense: 0, profit: 0 };
    bucket.expense += e.amount;
    dailyTotals.set(day, bucket);
  }

  const profit = revenue - cogs - totalExpenses - expiredWriteOff;

  const salesTrend = [...dailyTotals.values()].sort((a, b) => a.date.localeCompare(b.date));
  // approximate daily profit split proportionally to revenue share, for the chart only - the summary profit figure above is the authoritative one
  const totalTrendRevenue = salesTrend.reduce((s, d) => s + d.revenue, 0) || 1;
  salesTrend.forEach((d) => {
    d.profit = Number((profit * (d.revenue / totalTrendRevenue)).toFixed(2));
  });

  const fastMovers = [...productTotals.entries()]
    .map(([productId, v]) => ({ productId, ...v }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 5);

  const categoryIds = [...categoryTotals.keys()].filter((k) => k !== "uncategorized");
  const categories = await Category.find({ _id: { $in: categoryIds } });
  const categoryNameById = new Map(categories.map((c) => [String(c._id), c.name]));
  const revenueByCategory = [...categoryTotals.entries()].map(([id, total]) => ({
    category: id === "uncategorized" ? "Uncategorized" : categoryNameById.get(id) || "Unknown",
    total: Number(total.toFixed(2)),
  }));

  const lowStock = await Product.find({ isActive: true, qty: { $gt: 0 } })
    .then((all) => all.filter((p) => p.qty <= p.lowStockThreshold).sort((a, b) => a.qty - b.qty).slice(0, 5));

  const now = new Date();
  const soonCutoff = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const expiringSoon = await Batch.find({ qtyRemaining: { $gt: 0 }, expiryDate: { $lte: soonCutoff } })
    .populate({ path: "product", select: "name productCode isActive", match: { isActive: true } })
    .sort({ expiryDate: 1 })
    .limit(20)
    .then((batches) => batches.filter((b) => b.product).slice(0, 5));

  return {
    revenue: Number(revenue.toFixed(2)),
    cogs: Number(cogs.toFixed(2)),
    expenses: Number(totalExpenses.toFixed(2)),
    expiredWriteOff: Number(expiredWriteOff.toFixed(2)),
    profit: Number(profit.toFixed(2)),
    outputGst: Number(outputGst.toFixed(2)),
    inputGst: Number(inputGst.toFixed(2)),
    netGst: Number((outputGst - inputGst).toFixed(2)),
    totalPurchases: Number(totalPurchases.toFixed(2)),
    salesCount: sales.length,
    fastMovers,
    lowStock,
    expiringSoon,
    salesTrend,
    revenueByCategory,
  };
}

router.get("/summary", async (req, res) => {
  const { start, end } = resolveRange(req);
  const summary = await computeSummary(start, end);
  res.json(summary);
});

router.get("/export", async (req, res) => {
  const { start, end } = resolveRange(req);
  const summary = await computeSummary(start, end);

  const sales = await Sale.find({ createdAt: { $gte: start, $lte: end } }).populate("customer", "name phone");
  const purchases = await Purchase.find({ date: { $gte: start, $lte: end } }).populate("vendor", "name");
  const expenses = await Expense.find({ date: { $gte: start, $lte: end } });

  const workbook = new ExcelJS.Workbook();

  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.columns = [{ header: "Metric", key: "k", width: 30 }, { header: "Value", key: "v", width: 20 }];
  summarySheet.addRows([
    { k: "Period", v: `${start.toDateString()} - ${end.toDateString()}` },
    { k: "Revenue", v: summary.revenue },
    { k: "Cost of Goods Sold", v: summary.cogs },
    { k: "Expenses", v: summary.expenses },
    { k: "Expired Stock Write-off", v: summary.expiredWriteOff },
    { k: "Profit", v: summary.profit },
    { k: "Output GST", v: summary.outputGst },
    { k: "Input GST", v: summary.inputGst },
    { k: "Net GST Payable", v: summary.netGst },
  ]);

  const salesSheet = workbook.addWorksheet("Sales");
  salesSheet.columns = [
    { header: "Bill No", key: "billNo", width: 16 },
    { header: "Date", key: "date", width: 20 },
    { header: "Customer", key: "customer", width: 20 },
    { header: "Subtotal", key: "subtotal", width: 12 },
    { header: "GST", key: "gst", width: 12 },
    { header: "Discount", key: "discount", width: 12 },
    { header: "Total", key: "total", width: 12 },
    { header: "Status", key: "status", width: 12 },
  ];
  sales.forEach((s) =>
    salesSheet.addRow({
      billNo: s.billNo,
      date: s.createdAt.toISOString().slice(0, 10),
      customer: s.customer?.name || "Walk-in",
      subtotal: s.subtotal,
      gst: s.gstAmount,
      discount: s.discount,
      total: s.total,
      status: s.paymentStatus,
    })
  );

  const purchasesSheet = workbook.addWorksheet("Purchases");
  purchasesSheet.columns = [
    { header: "Invoice No", key: "invoiceNo", width: 16 },
    { header: "Date", key: "date", width: 20 },
    { header: "Vendor", key: "vendor", width: 20 },
    { header: "Subtotal", key: "subtotal", width: 12 },
    { header: "GST", key: "gst", width: 12 },
    { header: "TDS", key: "tds", width: 12 },
    { header: "Total", key: "total", width: 12 },
  ];
  purchases.forEach((p) =>
    purchasesSheet.addRow({
      invoiceNo: p.invoiceNo,
      date: p.date.toISOString().slice(0, 10),
      vendor: p.vendor?.name,
      subtotal: p.subtotal,
      gst: p.gstAmount,
      tds: p.tdsAmount,
      total: p.total,
    })
  );

  const expensesSheet = workbook.addWorksheet("Expenses");
  expensesSheet.columns = [
    { header: "Date", key: "date", width: 20 },
    { header: "Category", key: "category", width: 16 },
    { header: "Amount", key: "amount", width: 12 },
    { header: "Notes", key: "notes", width: 30 },
  ];
  expenses.forEach((e) =>
    expensesSheet.addRow({ date: e.date.toISOString().slice(0, 10), category: e.category, amount: e.amount, notes: e.notes })
  );

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=GHM_Report.xlsx");
  await workbook.xlsx.write(res);
  res.end();
});

export default router;
