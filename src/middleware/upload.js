import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED = ["image/jpeg", "image/png", "image/webp"];

// Local disk storage doesn't survive a redeploy/restart on almost any hosting
// platform, so production uses Cloudinary instead - but only once its env
// vars are actually set, so local development still works with zero setup.
export const usingCloudinary = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);

let storage;

if (usingCloudinary) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  storage = new CloudinaryStorage({
    cloudinary,
    params: { folder: "ghm-products", allowed_formats: ["jpg", "jpeg", "png", "webp"] },
  });
} else {
  const uploadsDir = path.join(__dirname, "..", "..", "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  });
}

export const uploadProductImage = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED.includes(file.mimetype)) {
      return cb(new Error("Image must be JPG, PNG or WEBP and under 2 MB."));
    }
    cb(null, true);
  },
}).single("image");

// Cloudinary's storage engine puts the final hosted URL on file.path; the
// local disk fallback only has a filename, served from /uploads (see server.js).
export function uploadedImageUrl(file) {
  if (!file) return undefined;
  return usingCloudinary ? file.path : `/uploads/${file.filename}`;
}
