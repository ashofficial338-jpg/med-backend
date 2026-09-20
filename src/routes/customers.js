import { Router } from "express";
import Customer from "../models/Customer.js";
import Sale from "../models/Sale.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

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
  if (q) {
    filter.$or = [{ name: new RegExp(q, "i") }, { phone: new RegExp(q, "i") }];
  }
  const customers = await Customer.find(filter).sort({ name: 1 }).limit(20);
  res.json(customers);
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
  res.json({ customer, bills });
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
