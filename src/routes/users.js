import { Router } from "express";
import bcrypt from "bcryptjs";
import { body, validationResult } from "express-validator";
import User from "../models/User.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("admin"));

router.get("/", async (req, res) => {
  const q = (req.query.q || "").trim();
  const filter = q
    ? {
        $or: [
          { email: new RegExp(q, "i") },
          { username: new RegExp(q, "i") },
        ],
      }
    : {};
  const users = await User.find(filter).select("-passwordHash").sort({ createdAt: -1 });
  res.json(users);
});

router.post(
  "/",
  [
    body("email").isEmail().withMessage("Please enter a valid email address."),
    body("username").trim().isLength({ min: 1, max: 50 }).withMessage("This field is required."),
    body("role").isIn(["admin", "staff"]).withMessage("This field is required."),
    body("password")
      .isLength({ min: 6, max: 15 })
      .withMessage("Password must be between 6 and 15 characters."),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const { email, username, role, password, isActive = true } = req.body;

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ message: "This value is already in use." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      email: email.toLowerCase().trim(),
      username,
      role,
      passwordHash,
      isActive,
    });

    res.status(201).json({
      id: user._id,
      email: user.email,
      username: user.username,
      role: user.role,
      isActive: user.isActive,
    });
  }
);

router.patch(
  "/:id",
  [
    body("username").optional().trim().isLength({ min: 1, max: 50 }),
    body("role").optional().isIn(["admin", "staff"]),
    body("isActive").optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "No records found." });
    }

    if (req.body.isActive === false && user.role === "admin") {
      const activeAdmins = await User.countDocuments({ role: "admin", isActive: true });
      if (activeAdmins <= 1) {
        return res.status(400).json({ message: "You cannot deactivate the only Admin account." });
      }
    }

    if (req.body.username !== undefined) user.username = req.body.username;
    if (req.body.role !== undefined) user.role = req.body.role;
    if (req.body.isActive !== undefined) user.isActive = req.body.isActive;
    await user.save();

    res.json({
      id: user._id,
      email: user.email,
      username: user.username,
      role: user.role,
      isActive: user.isActive,
    });
  }
);

router.post(
  "/:id/reset-password",
  [
    body("newPassword")
      .isLength({ min: 6, max: 15 })
      .withMessage("Password must be between 6 and 15 characters."),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "No records found." });
    }

    user.passwordHash = await bcrypt.hash(req.body.newPassword, 10);
    await user.save();

    res.json({ message: "Password reset." });
  }
);

export default router;
