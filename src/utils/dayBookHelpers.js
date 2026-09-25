import Sale from "../models/Sale.js";
import Purchase from "../models/Purchase.js";
import Expense from "../models/Expense.js";
import CustomerPayment from "../models/CustomerPayment.js";
import SupplierPayment from "../models/SupplierPayment.js";
import DayBookAdjustment from "../models/DayBookAdjustment.js";

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

async function sumWhere(Model, match, field) {
  const rows = await Model.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: `$${field}` } } }]);
  return rows[0]?.total || 0;
}

// Cash/UPI in = sales paid in full in that mode (non-Credit sales never get a
// CustomerPayment row - see sales.js) + any CustomerPayment collected in that
// mode (an advance or a later credit collection - the latter is
// simultaneously real cash in AND a receivables decrease, see the Credit
// branch below - proper double-entry without formalizing it).
// Cash/UPI out = expenses paid in that mode + non-Credit purchases paid in
// full in that mode (mirrors the sales side - see purchases.js, only a
// Credit purchase's advance/later payments get a SupplierPayment row) +
// SupplierPayments made in that mode. Card/Bank Transfer/Cheque/Other sit
// outside all three tracked buckets by design - matches "Cash, UPI, Credit"
// as asked.
async function computeFlow(type, dateRange) {
  if (type === "Credit") {
    const inFlow = await sumWhere(Sale, { paymentMode: "Credit", paymentStatus: { $ne: "void" }, createdAt: dateRange }, "total");
    const outFlow = await sumWhere(CustomerPayment, { date: dateRange }, "amount");
    return { in: Number(inFlow.toFixed(2)), out: Number(outFlow.toFixed(2)) };
  }

  const inSales = await sumWhere(Sale, { paymentMode: type, paymentStatus: { $ne: "void" }, createdAt: dateRange }, "total");
  const inPayments = await sumWhere(CustomerPayment, { mode: type, date: dateRange }, "amount");
  const outExpenses = await sumWhere(Expense, { paymentMode: type, date: dateRange }, "amount");
  const outPurchases = await sumWhere(Purchase, { paymentMode: type, date: dateRange }, "total");
  const outSupplier = await sumWhere(SupplierPayment, { mode: type, date: dateRange }, "amount");
  return {
    in: Number((inSales + inPayments).toFixed(2)),
    out: Number((outExpenses + outPurchases + outSupplier).toFixed(2)),
  };
}

// The balance for `type` as of the end of `date` - anchored to the most
// recent manual reconciliation (DayBookAdjustment) at or before that day, plus
// every transaction since. With no adjustment ever recorded, the anchor is 0
// since the beginning of the ledger. This is what makes "opening balance"
// auto-carry-forward: tomorrow's opening is just today's closing, computed
// fresh rather than stored, so a backdated transaction never desyncs anything.
export async function balanceAsOf(type, date) {
  const through = endOfDay(date);
  const anchor = await DayBookAdjustment.findOne({ type, date: { $lte: through } }).sort({ date: -1 });
  const range = anchor ? { $gt: anchor.date, $lte: through } : { $lte: through };
  const { in: inFlow, out: outFlow } = await computeFlow(type, range);
  const base = anchor ? anchor.balance : 0;
  return Number((base + inFlow - outFlow).toFixed(2));
}

export async function dayBookSummary(date) {
  const day = startOfDay(date);
  const dayEnd = endOfDay(date);
  const prevDayEnd = new Date(day.getTime() - 1);

  const result = {};
  for (const type of ["Cash", "UPI", "Credit"]) {
    const opening = await balanceAsOf(type, prevDayEnd);
    const closing = await balanceAsOf(type, day);
    const { in: inFlow, out: outFlow } = await computeFlow(type, { $gte: day, $lte: dayEnd });
    result[type.toLowerCase()] = { opening, in: inFlow, out: outFlow, closing };
  }
  return result;
}
