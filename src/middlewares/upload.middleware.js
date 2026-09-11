import multer from "multer";
import path from "path";
import fs from "fs";

// Carpeta donde se guardan las imágenes subidas. Debe existir antes de que
// multer intente escribir en ella.
const CARPETA_PRODUCTOS = path.join(process.cwd(), "uploads", "productos");
fs.mkdirSync(CARPETA_PRODUCTOS, { recursive: true });

const EXTENSIONES_PERMITIDAS = [".jpg", ".jpeg", ".png", ".webp"];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CARPETA_PRODUCTOS),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const nombre = `producto-${req.params.id}-${Date.now()}${ext}`;
    cb(null, nombre);
  },
});

const filtroArchivo = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!EXTENSIONES_PERMITIDAS.includes(ext)) {
    const error = new Error("Formato de imagen no permitido. Usa JPG, PNG o WEBP.");
    error.status = 400;
    return cb(error);
  }
  cb(null, true);
};

const uploadImagenProducto = multer({
  storage,
  fileFilter: filtroArchivo,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

export { uploadImagenProducto };
