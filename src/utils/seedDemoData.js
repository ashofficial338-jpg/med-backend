import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import Category from "../models/Category.js";
import Vendor from "../models/Vendor.js";
import Customer from "../models/Customer.js";
import Product from "../models/Product.js";
import Purchase from "../models/Purchase.js";
import Sale from "../models/Sale.js";
import Expense from "../models/Expense.js";
import StockLedger from "../models/StockLedger.js";
import { generateProductCode, resolveCategory, computeLooseRate } from "./productHelpers.js";
import { computeInternalQty } from "./stockUnits.js";
import { saleLineInternalQty, generateBillNo } from "./saleHelpers.js";
import { upsertBatch, allocateFefo } from "./batchHelpers.js";

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function getOrCreate(Model, query, data) {
  const existing = await Model.findOne(query);
  if (existing) return existing;
  return Model.create(data);
}

async function makePurchase({ vendor, invoiceNo, date, admin, lines }) {
  const items = [];
  let subtotal = 0;
  let gstAmount = 0;

  for (const line of lines) {
    const product = line.product;
    const lineAmount = Number((line.qtyPacks * line.costPrice).toFixed(2));
    const lineGst = Number(((lineAmount * product.gstPercent) / 100).toFixed(2));
    subtotal += lineAmount;
    gstAmount += lineGst;
    items.push({
      product: product._id,
      qtyPacks: line.qtyPacks,
      costPrice: line.costPrice,
      batchNo: line.batchNo,
      expiryDate: line.expiryDate,
      lineAmount,
      lineGst,
    });
  }

  subtotal = Number(subtotal.toFixed(2));
  gstAmount = Number(gstAmount.toFixed(2));
  const total = Number((subtotal + gstAmount).toFixed(2));

  const purchase = await Purchase.create({
    vendor: vendor._id,
    invoiceNo,
    date,
    items,
    subtotal,
    gstAmount,
    tdsAmount: 0,
    total,
    createdBy: admin._id,
  });

  for (const line of lines) {
    const product = line.product;
    const addQty = computeInternalQty({
      soldAs: product.soldAs,
      unitsPerPack: product.unitsPerPack,
      qtyPacks: line.qtyPacks,
      qtyLooseExtra: 0,
    });

    const batch = await upsertBatch({
      product,
      batchNo: line.batchNo,
      expiryDate: line.expiryDate,
      costPrice: line.costPrice,
      addQty,
      receivedAt: date,
      purchase: purchase._id,
    });

    product.qty += addQty;
    await product.save();

    await StockLedger.create({
      product: product._id,
      batch: batch._id,
      type: "purchase",
      qtyChange: addQty,
      reason: `Purchase invoice ${invoiceNo}`,
      refId: purchase._id,
      performedBy: admin._id,
    });
  }

  return purchase;
}

async function makeSale({ customer, admin, paymentMode, createdAt, lines }) {
  const resolved = [];

  for (const line of lines) {
    const product = line.product;
    const qty = line.qty;
    const internalQty = saleLineInternalQty(product, line.unitType, qty);
    const rate = line.unitType === "pack" ? product.packRate : product.looseRate;
    const unitLabel = line.unitType === "pack" ? product.packUnit : product.looseUnitName;
    const amount = Number((qty * rate).toFixed(2));
    const gstAmount = Number(((amount * product.gstPercent) / 100).toFixed(2));

    const breakdown = await allocateFefo(product, internalQty);
    const costAmount = Number(breakdown.reduce((sum, b) => sum + b.qty * b.costPricePerUnit, 0).toFixed(2));

    resolved.push({
      product,
      line: {
        product: product._id,
        name: product.name,
        unitType: line.unitType,
        unitLabel,
        qty,
        rate,
        gstPercent: product.gstPercent,
        amount,
        gstAmount,
        internalQtyDeducted: internalQty,
        costAmount,
        batchBreakdown: breakdown,
      },
    });
  }

  for (const { product, line } of resolved) {
    product.qty -= line.internalQtyDeducted;
    await product.save();
  }

  const subtotal = Number(resolved.reduce((s, r) => s + r.line.amount, 0).toFixed(2));
  const gstAmount = Number(resolved.reduce((s, r) => s + r.line.gstAmount, 0).toFixed(2));
  const total = Number((subtotal + gstAmount).toFixed(2));

  const billNo = await generateBillNo();
  const sale = await Sale.create({
    billNo,
    customer: customer ? customer._id : null,
    items: resolved.map((r) => r.line),
    subtotal,
    gstAmount,
    discount: 0,
    total,
    paymentMode,
    createdBy: admin._id,
  });

  for (const { line } of resolved) {
    for (const b of line.batchBreakdown) {
      await StockLedger.create({
        product: line.product,
        batch: b.batch,
        type: "sale",
        qtyChange: -b.qty,
        reason: `Sale ${billNo}`,
        refId: sale._id,
        performedBy: admin._id,
      });
    }
  }

  // Backdate createdAt (Sale.create always stamps "now" via timestamps) so the
  // dashboard's 30-day trend chart has more than a single day of data.
  // Mongoose treats timestamp fields as immutable and silently strips them from
  // Model.updateOne() - go through the native driver to actually change it.
  if (createdAt) {
    await Sale.collection.updateOne({ _id: sale._id }, { $set: { createdAt } });
  }

  return sale;
}

async function seed() {
  await connectDB();

  const admin = await User.findOne({ role: "admin" });
  if (!admin) {
    console.error("No admin user found. Run `npm run seed` first to create one.");
    process.exit(1);
  }

  // Categories
  const [tabletCat, syrupCat, injectionCat, ointmentCat] = await Promise.all([
    getOrCreate(Category, { name: "Tablet" }, { name: "Tablet" }),
    getOrCreate(Category, { name: "Syrup" }, { name: "Syrup" }),
    getOrCreate(Category, { name: "Injection" }, { name: "Injection" }),
    getOrCreate(Category, { name: "Ointment" }, { name: "Ointment" }),
  ]);
  console.log("Categories ready");

  // Vendors
  const vendorDefs = [
    { name: "MedPlus Distributors", contactPerson: "Suresh Nair", phone: "9876543210", email: "orders@medplusdist.example", address: "12 Anna Salai, Chennai", gstNumber: "33ABCPD1234F1Z5" },
    { name: "Apollo Pharma Supplies", contactPerson: "Lakshmi Iyer", phone: "9876543211", email: "sales@apollopharma.example", address: "45 MG Road, Bengaluru", gstNumber: "29ABCPD1234F1Z6" },
    { name: "Cipla Wholesale", contactPerson: "Ravi Menon", phone: "9876543212", email: "wholesale@cipla.example", address: "8 Linking Road, Mumbai", gstNumber: "27ABCPD1234F1Z7" },
    { name: "Sun Pharma Traders", contactPerson: "Anita Desai", phone: "9876543213", email: "traders@sunpharma.example", address: "22 Park Street, Kolkata", gstNumber: "19ABCPD1234F1Z8" },
    { name: "Zydus Health Supply", contactPerson: "Vikram Shah", phone: "9876543214", email: "supply@zydus.example", address: "3 SG Highway, Ahmedabad", gstNumber: "24ABCPD1234F1Z9" },
  ];
  const vendors = [];
  for (const v of vendorDefs) vendors.push(await getOrCreate(Vendor, { phone: v.phone }, v));
  console.log("Vendors ready");

  // Customers
  const customerDefs = [
    { name: "Ramesh Kumar", phone: "9000000001", email: "ramesh.kumar@example.com", address: "14 Gandhi Nagar" },
    { name: "Priya Sharma", phone: "9000000002", email: "priya.sharma@example.com", address: "27 Nehru Street" },
    { name: "Arun Velusamy", phone: "9000000003", email: "", address: "5 Lake View Road" },
    { name: "Divya Rajan", phone: "9000000004", email: "divya.rajan@example.com", address: "19 Church Road" },
    { name: "Karthik Subramaniam", phone: "9000000005", email: "", address: "31 Market Street" },
  ];
  const customers = [];
  for (const c of customerDefs) customers.push(await getOrCreate(Customer, { phone: c.phone }, c));
  console.log("Customers ready");

  // Products - batchNo/expiryDate/costPrice describe the OPENING batch only
  // (created separately below via the Purchases step, same as the real app);
  // Product itself no longer stores them.
  async function createProduct(def) {
    const existing = await Product.findOne({ name: def.name });
    if (existing) return existing;
    const productCode = await generateProductCode(def.name);
    const looseRate = computeLooseRate({ soldAs: def.soldAs, packRate: def.packRate, unitsPerPack: def.unitsPerPack });
    const { batchNo, expiryDate, costPrice, ...productFields } = def;
    return Product.create({ ...productFields, productCode, looseRate, qty: 0 });
  }

  const doloDef = {
    name: "Dolo 650",
    category: tabletCat._id,
    strengthValue: 650,
    strengthUnit: "mg",
    soldAs: "pack-and-loose",
    packUnit: "Strip",
    unitsPerPack: 15,
    looseUnitName: "Tablet",
    packRate: 32,
    costPrice: 22,
    gstPercent: 12,
    hsnCode: "3004",
    batchNo: "B24117",
    expiryDate: daysAgo(-540),
    lowStockThreshold: 20,
    vendor: vendors[0]._id,
  };
  const dolo = await createProduct(doloDef);

  const azithroDef = {
    name: "Azithromycin 500",
    category: tabletCat._id,
    strengthValue: 500,
    strengthUnit: "mg",
    soldAs: "pack-and-loose",
    packUnit: "Strip",
    unitsPerPack: 6,
    looseUnitName: "Tablet",
    packRate: 90,
    costPrice: 60,
    gstPercent: 12,
    hsnCode: "3004",
    batchNo: "B24218",
    expiryDate: daysAgo(-365),
    lowStockThreshold: 15,
    vendor: vendors[1]._id,
  };
  const azithro = await createProduct(azithroDef);

  const coughSyrupDef = {
    name: "Corex Cough Syrup",
    category: syrupCat._id,
    strengthValue: 100,
    strengthUnit: "ml",
    soldAs: "pack-only",
    packUnit: "Bottle",
    packRate: 85,
    costPrice: 55,
    gstPercent: 5,
    hsnCode: "3004",
    batchNo: "B24319",
    expiryDate: daysAgo(-450),
    lowStockThreshold: 10,
    vendor: vendors[2]._id,
  };
  const coughSyrup = await createProduct(coughSyrupDef);

  const insulinDef = {
    name: "Human Insulin Injection",
    category: injectionCat._id,
    strengthValue: 100,
    strengthUnit: "ml",
    soldAs: "pack-only",
    packUnit: "Vial",
    packRate: 350,
    costPrice: 280,
    gstPercent: 5,
    hsnCode: "3004",
    batchNo: "B24420",
    expiryDate: daysAgo(-300),
    lowStockThreshold: 10,
    vendor: vendors[3]._id,
  };
  const insulin = await createProduct(insulinDef);

  const ointmentDef = {
    name: "Moisturizing Ointment",
    category: ointmentCat._id,
    soldAs: "pack-only",
    packUnit: "Tube",
    packRate: 120,
    costPrice: 80,
    gstPercent: 18,
    hsnCode: "3304",
    batchNo: "B24521",
    expiryDate: daysAgo(-600),
    lowStockThreshold: 15,
    vendor: vendors[4]._id,
  };
  const ointment = await createProduct(ointmentDef);
  console.log("Products ready");

  // Purchases (stock-in)
  const purchaseDefs = [
    { vendor: vendors[0], invoiceNo: "INV-1001", date: daysAgo(24), lines: [{ product: dolo, qtyPacks: 20, costPrice: doloDef.costPrice, batchNo: doloDef.batchNo, expiryDate: doloDef.expiryDate }] },
    { vendor: vendors[1], invoiceNo: "INV-2001", date: daysAgo(22), lines: [{ product: azithro, qtyPacks: 15, costPrice: azithroDef.costPrice, batchNo: azithroDef.batchNo, expiryDate: azithroDef.expiryDate }] },
    { vendor: vendors[2], invoiceNo: "INV-3001", date: daysAgo(20), lines: [{ product: coughSyrup, qtyPacks: 25, costPrice: coughSyrupDef.costPrice, batchNo: coughSyrupDef.batchNo, expiryDate: coughSyrupDef.expiryDate }] },
    { vendor: vendors[3], invoiceNo: "INV-4001", date: daysAgo(18), lines: [{ product: insulin, qtyPacks: 30, costPrice: insulinDef.costPrice, batchNo: insulinDef.batchNo, expiryDate: insulinDef.expiryDate }] },
    { vendor: vendors[4], invoiceNo: "INV-5001", date: daysAgo(16), lines: [{ product: ointment, qtyPacks: 40, costPrice: ointmentDef.costPrice, batchNo: ointmentDef.batchNo, expiryDate: ointmentDef.expiryDate }] },
  ];
  for (const p of purchaseDefs) {
    const exists = await Purchase.findOne({ vendor: p.vendor._id, invoiceNo: p.invoiceNo });
    if (exists) continue;
    await makePurchase({ ...p, admin });
  }
  console.log("Purchases ready, stock updated");

  // Sales, spread across the last ~10 days
  const saleDefs = [
    { customer: customers[0], paymentMode: "Cash", createdAt: daysAgo(10), lines: [{ product: dolo, unitType: "loose", qty: 10 }, { product: coughSyrup, unitType: "pack", qty: 1 }] },
    { customer: customers[1], paymentMode: "UPI", createdAt: daysAgo(9), lines: [{ product: azithro, unitType: "pack", qty: 1 }] },
    { customer: null, paymentMode: "Cash", createdAt: daysAgo(8), lines: [{ product: ointment, unitType: "pack", qty: 2 }] },
    { customer: customers[2], paymentMode: "Card", createdAt: daysAgo(7), lines: [{ product: dolo, unitType: "pack", qty: 2 }, { product: insulin, unitType: "pack", qty: 1 }] },
    { customer: customers[3], paymentMode: "Cash", createdAt: daysAgo(5), lines: [{ product: coughSyrup, unitType: "pack", qty: 2 }] },
    { customer: customers[4], paymentMode: "UPI", createdAt: daysAgo(4), lines: [{ product: azithro, unitType: "loose", qty: 12 }] },
    { customer: null, paymentMode: "Cash", createdAt: daysAgo(2), lines: [{ product: dolo, unitType: "loose", qty: 20 }, { product: ointment, unitType: "pack", qty: 1 }] },
    { customer: customers[0], paymentMode: "Card", createdAt: daysAgo(0), lines: [{ product: insulin, unitType: "pack", qty: 2 }, { product: coughSyrup, unitType: "pack", qty: 1 }] },
  ];
  if (await Sale.countDocuments()) {
    console.log("Sales already present, skipping");
  } else {
    for (const s of saleDefs) {
      await makeSale({ ...s, admin });
    }
    console.log("Sales ready");
  }

  // Expenses
  const expenseDefs = [
    { category: "Rent", amount: 15000, date: daysAgo(25), notes: "Monthly shop rent" },
    { category: "Salary", amount: 20000, date: daysAgo(20), notes: "Staff salary" },
    { category: "Utilities", amount: 3200, date: daysAgo(15), notes: "Electricity bill" },
    { category: "Other", amount: 1500, date: daysAgo(10), notes: "Cleaning supplies" },
    { category: "Utilities", amount: 800, date: daysAgo(5), notes: "Internet bill" },
  ];
  if (await Expense.countDocuments()) {
    console.log("Expenses already present, skipping");
  } else {
    for (const e of expenseDefs) {
      await Expense.create({ ...e, createdBy: admin._id });
    }
    console.log("Expenses ready");
  }

  console.log("\nDemo data seeded successfully.");
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
