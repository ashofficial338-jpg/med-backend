import { Router } from "express";
import bcrypt from "bcryptjs";
import { body, validationResult } from "express-validator";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.patch(
  "/",
  requireAuth,
  [body("username").trim().isLength({ min: 1, max: 50 }).withMessage("This field is required.")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    req.user.username = req.body.username;
    await req.user.save();

    res.json({
      id: req.user._id,
      email: req.user.email,
      username: req.user.username,
      role: req.user.role,
    });
  }
);

router.post(
  "/change-password",
  requireAuth,
  [
    body("currentPassword").notEmpty().withMessage("This field is required."),
    body("newPassword")
      .isLength({ min: 6, max: 15 })
      .withMessage("Password must be between 6 and 15 characters."),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const { currentPassword, newPassword } = req.body;

    const isMatch = await bcrypt.compare(currentPassword, req.user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    const isSame = await bcrypt.compare(newPassword, req.user.passwordHash);
    if (isSame) {
      return res
        .status(400)
        .json({ message: "New password must be different from the current password." });
    }

    req.user.passwordHash = await bcrypt.hash(newPassword, 10);
    await req.user.save();

    res.json({ message: "Password updated." });
  }
);

export default router;
