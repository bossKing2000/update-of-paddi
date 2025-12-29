// import multer, { FileFilterCallback } from 'multer';
// import path from 'path';
// import fs from 'fs';
// import { Request } from 'express';

// const UPLOAD_DIR = path.join(__dirname, '../../uploads');

// // Ensure the uploads folder exists
// if (!fs.existsSync(UPLOAD_DIR)) {
//   fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// }

// const storage = multer.diskStorage({
//   destination: (_req: Request, _file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => {
//     cb(null, UPLOAD_DIR);
//   },
//   filename: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
//     const safeName = file.originalname.replace(/\s+/g, '-'); // replaces spaces with dashes
//     cb(null, `${Date.now()}-${safeName}`);
//   },
// });

// const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback): void => {
//   if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
//     cb(null, true);
//   } else {
//     cb(new Error('Only images and videos are allowed'));
//   }
// };

// export const upload = multer({
//   storage,
//   fileFilter,
//   limits: { files: 9 },
// });




import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";


// ✅ No need for manual config — it will auto-detect CLOUDINARY_URL
cloudinary.config({
    cloudinary_url: process.env.CLOUDINARY_URL!,
}); 

// Create storage engine
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (_req, file) => {
    return {
      folder: "food-paddi", // Cloudinary folder
      resource_type: file.mimetype.startsWith("video/") ? "video" : "image",
      public_id: `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`,
    };
  },
});

// File filter (optional, to restrict file types)
const fileFilter = (_req: any, file: Express.Multer.File, cb: any) => {
  if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) {
    cb(null, true);
  } else {
    cb(new Error("Only images and videos are allowed"));
  }
};

// Multer instance
export const upload = multer({
  storage,
  fileFilter,
  limits: { files: 9 },
});
