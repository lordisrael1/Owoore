import multer from 'multer';
import { Errors } from '../utils/AppError';

const storage = multer.memoryStorage();

export const uploadLogo = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(Errors.badRequest('Only image files are allowed'));
    }
  },
}).single('logo_url');
