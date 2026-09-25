import Purchase from "../models/Purchase.js";
import { balanceDue } from "./ledgerHelpers.js";

function periodKey(date, period) {
  const d = new Date(date);
  const year = d.getFullYear();
  if (period === "quarter") {
    const quarter = Math.ceil((d.getMonth() + 1) / 3);
    return `${year}-Q${quarter}`;
  }
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

// Buckets a vendor's purchase history by calendar month or quarter, in plain
// JS (mirrors dashboard.js's computeSummary Map-based bucketing) rather than
// a Mongo aggregation pipeline - simpler and plenty fast at this data volume.
export async function buildVendorReport(vendorId, period = "month") {
  const purchases = await Purchase.find({ vendor: vendorId }).sort({ date: 1 });

  const buckets = new Map();
  for (const purchase of purchases) {
    const key = periodKey(purchase.date, period);
    const bucket = buckets.get(key) || { period: key, invoiceCount: 0, totalPurchases: 0, totalPaid: 0, outstanding: 0 };
    bucket.invoiceCount += 1;
    bucket.totalPurchases += purchase.total;
    const paid = purchase.amountPaid ?? purchase.total;
    bucket.totalPaid += paid;
    bucket.outstanding += balanceDue(purchase);
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((b) => ({
      ...b,
      totalPurchases: Number(b.totalPurchases.toFixed(2)),
      totalPaid: Number(b.totalPaid.toFixed(2)),
      outstanding: Number(b.outstanding.toFixed(2)),
    }));
}
