import Sale from "../models/Sale.js";
import Purchase from "../models/Purchase.js";
import CustomerPayment from "../models/CustomerPayment.js";
import SupplierPayment from "../models/SupplierPayment.js";
import { nextSequence } from "../models/Counter.js";

export async function generatePaymentNo(kind) {
  const seq = await nextSequence(kind === "customer" ? "customerPaymentNo" : "supplierPaymentNo");
  const prefix = kind === "customer" ? "RCV" : "PAY";
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}

// A doc's own amountPaid is the only thing that ever changes its balance -
// missing amountPaid (pre-migration records) reads as fully paid, never as a
// fabricated historical debt.
export function balanceDue(doc) {
  const paid = doc.amountPaid ?? doc.total;
  return Number((doc.total - paid).toFixed(2));
}

// Applies `amount` across `openDocs` (oldest first), topping up each one's
// amountPaid until its balance is cleared before moving to the next. Caller
// must have already checked amount <= sum of the docs' balances. Saves every
// doc it touches; returns nothing (docs are mutated in place).
async function allocateFifo(openDocs, amount) {
  let remaining = amount;
  for (const doc of openDocs) {
    if (remaining <= 0) break;
    const due = balanceDue(doc);
    if (due <= 0) continue;
    const take = Math.min(due, remaining);
    doc.amountPaid = Number(((doc.amountPaid ?? 0) + take).toFixed(2));
    await doc.save();
    remaining = Number((remaining - take).toFixed(2));
  }
}

function mergeLedgerEntries(debits, credits) {
  const entries = [
    ...debits.map((e) => ({ ...e, debit: e.amount, credit: 0 })),
    ...credits.map((e) => ({ ...e, debit: 0, credit: e.amount })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  let balance = 0;
  for (const entry of entries) {
    balance = Number((balance + entry.debit - entry.credit).toFixed(2));
    entry.balance = balance;
    delete entry.amount;
  }
  return entries;
}

export async function buildCustomerLedger(customerId) {
  const [sales, payments] = await Promise.all([
    Sale.find({ customer: customerId, paymentMode: "Credit", paymentStatus: { $ne: "void" } }).sort({ createdAt: 1 }),
    CustomerPayment.find({ customer: customerId }).sort({ date: 1 }),
  ]);

  const entries = mergeLedgerEntries(
    sales.map((s) => ({ date: s.createdAt, type: "Credit Sale", ref: s.billNo, amount: s.total })),
    payments.map((p) => ({ date: p.date, type: "Payment Received", ref: p.paymentNo, amount: p.amount }))
  );
  const outstandingBalance = Number(sales.reduce((sum, s) => sum + balanceDue(s), 0).toFixed(2));
  const openSales = sales
    .map((s) => ({ _id: s._id, billNo: s.billNo, balanceDue: balanceDue(s) }))
    .filter((s) => s.balanceDue > 0);
  return { entries, outstandingBalance, openSales };
}

export async function buildSupplierLedger(vendorId) {
  const [purchases, payments] = await Promise.all([
    Purchase.find({ vendor: vendorId, paymentMode: "Credit" }).sort({ date: 1 }),
    SupplierPayment.find({ vendor: vendorId }).sort({ date: 1 }),
  ]);

  const entries = mergeLedgerEntries(
    purchases.map((p) => ({ date: p.date, type: "Purchase", ref: p.invoiceNo, amount: p.total })),
    payments.map((p) => ({ date: p.date, type: "Payment Made", ref: p.paymentNo, amount: p.amount }))
  );
  const outstandingBalance = Number(purchases.reduce((sum, p) => sum + balanceDue(p), 0).toFixed(2));
  const openPurchases = purchases
    .map((p) => ({ _id: p._id, invoiceNo: p.invoiceNo, balanceDue: balanceDue(p) }))
    .filter((p) => p.balanceDue > 0);
  return { entries, outstandingBalance, openPurchases };
}

// For list views - one aggregation instead of one query per row.
export async function customerOutstandingMap() {
  const rows = await Sale.aggregate([
    { $match: { paymentMode: "Credit", paymentStatus: { $ne: "void" }, customer: { $ne: null } } },
    { $project: { customer: 1, balance: { $subtract: ["$total", { $ifNull: ["$amountPaid", "$total"] }] } } },
    { $group: { _id: "$customer", outstanding: { $sum: "$balance" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), Number(r.outstanding.toFixed(2))]));
}

export async function vendorOutstandingMap() {
  const rows = await Purchase.aggregate([
    { $match: { paymentMode: "Credit" } },
    { $project: { vendor: 1, balance: { $subtract: ["$total", { $ifNull: ["$amountPaid", "$total"] }] } } },
    { $group: { _id: "$vendor", outstanding: { $sum: "$balance" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), Number(r.outstanding.toFixed(2))]));
}

// Records a payment against a customer's open Credit sales - either applied
// to one specific bill, or auto-allocated oldest-first across all of them.
export async function recordCustomerPayment({ customerId, amount, mode, date, note, saleId, recordedBy }) {
  if (saleId) {
    const sale = await Sale.findOne({ _id: saleId, customer: customerId, paymentMode: "Credit", paymentStatus: { $ne: "void" } });
    if (!sale) return { error: "No records found." };
    if (amount > balanceDue(sale)) return { error: "Amount exceeds this bill's outstanding balance." };
    await allocateFifo([sale], amount);
  } else {
    const openSales = await Sale.find({ customer: customerId, paymentMode: "Credit", paymentStatus: { $ne: "void" } }).sort({ createdAt: 1 });
    const outstanding = openSales.reduce((sum, s) => sum + balanceDue(s), 0);
    if (amount > outstanding) return { error: "Amount exceeds the customer's outstanding balance." };
    await allocateFifo(openSales, amount);
  }

  const paymentNo = await generatePaymentNo("customer");
  await CustomerPayment.create({
    paymentNo,
    customer: customerId,
    sale: saleId || null,
    amount,
    mode,
    date: date || new Date(),
    note: note || "",
    recordedBy,
  });
  return { paymentNo };
}

// Records a payment against a vendor's open Credit purchases - mirrors
// recordCustomerPayment above.
export async function recordSupplierPayment({ vendorId, amount, mode, date, note, purchaseId, recordedBy }) {
  if (purchaseId) {
    const purchase = await Purchase.findOne({ _id: purchaseId, vendor: vendorId, paymentMode: "Credit" });
    if (!purchase) return { error: "No records found." };
    if (amount > balanceDue(purchase)) return { error: "Amount exceeds this invoice's outstanding balance." };
    await allocateFifo([purchase], amount);
  } else {
    const openPurchases = await Purchase.find({ vendor: vendorId, paymentMode: "Credit" }).sort({ date: 1 });
    const outstanding = openPurchases.reduce((sum, p) => sum + balanceDue(p), 0);
    if (amount > outstanding) return { error: "Amount exceeds the vendor's outstanding balance." };
    await allocateFifo(openPurchases, amount);
  }

  const paymentNo = await generatePaymentNo("supplier");
  await SupplierPayment.create({
    paymentNo,
    vendor: vendorId,
    purchase: purchaseId || null,
    amount,
    mode,
    date: date || new Date(),
    note: note || "",
    recordedBy,
  });
  return { paymentNo };
}
