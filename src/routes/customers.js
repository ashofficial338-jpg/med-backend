import { Router } from "express";
import Customer from "../models/Customer.js";
import Sale from "../models/Sale.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { buildCustomerLedger, customerOutstandingMap, recordCustomerPayment } from "../utils/ledgerHelpers.js";

const router = Router();
router.use(requireAuth);

// Both roles can search/create - this is what the Billing/Checkout phone-search
// dropdown uses. Only Admin gets the full unfiltered directory + purchase history.
router.get("/", async (req, res) => {
  const { q } = req.query;
  const filter = { isActive: true };

  if (req.user.role === "staff" && !q) {
    return res.json([]); // staff can only search, not browse the full directory
  }
  // Admin's "browse all" load sends a single space as an empty-but-defined
  // query (see Customers.jsx) - a literal-space regex would then only match
  // customers whose name/phone happens to contain a space, silently hiding
  // every single-word-named customer from the directory. Only filter once
  // there's real search text.
  if (q && q.trim()) {
    filter.$or = [{ name: new RegExp(q.trim(), "i") }, { phone: new RegExp(q.trim(), "i") }];
  }
  const customers = await Customer.find(filter).sort({ name: 1 }).limit(20);

  if (req.user.role !== "admin") return res.json(customers);
  const outstandingMap = await customerOutstandingMap();
  res.json(customers.map((c) => ({ ...c.toObject(), outstandingBalance: outstandingMap.get(String(c._id)) || 0 })));
});

router.post("/", async (req, res) => {
  const { name, phone, email, address } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ message: "This field is required." });
  if (!/^\d{10}$/.test(phone || "")) {
    return res.status(400).json({ message: "Enter a valid 10-digit phone number." });
  }

  try {
    const existing = await Customer.findOne({ phone });
    if (existing) return res.status(409).json({ message: "A customer with this phone number already exists." });

    const customer = await Customer.create({ name: name.trim(), phone, email, address });
    res.status(201).json(customer);
  } catch (e) {
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

router.get("/:id", requireRole("admin"), async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) return res.status(404).json({ message: "No records found." });

  const bills = await Sale.find({ customer: customer._id }).sort({ createdAt: -1 });
  const { outstandingBalance } = await buildCustomerLedger(customer._id);
  res.json({ customer, bills, outstandingBalance });
});

router.get("/:id/ledger", requireRole("admin"), async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) return res.status(404).json({ message: "No records found." });

  const ledger = await buildCustomerLedger(customer._id);
  res.json({ customer, ...ledger });
});

router.post("/:id/payments", requireRole("admin"), async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) return res.status(404).json({ message: "No records found." });

  const { amount, mode, date, note, saleId } = req.body;
  const amountNum = Number(amount);
  if (!(amountNum > 0)) return res.status(400).json({ message: "Please enter a valid number." });

  const result = await recordCustomerPayment({
    customerId: customer._id,
    amount: amountNum,
    mode: mode || "Cash",
    date,
    note,
    saleId: saleId || null,
    recordedBy: req.user._id,
  });
  if (result.error) return res.status(400).json({ message: result.error });

  const ledger = await buildCustomerLedger(customer._id);
  res.status(201).json({ customer, ...ledger });
});

router.patch("/:id", requireRole("admin"), async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) return res.status(404).json({ message: "No records found." });

  const { name, email, address } = req.body;
  if (name !== undefined) customer.name = name;
  if (email !== undefined) customer.email = email;
  if (address !== undefined) customer.address = address;
  await customer.save();
  res.json(customer);
});

export default router;
