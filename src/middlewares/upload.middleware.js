import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";

const CARPETA_PRODUCTOS = path.join(process.cwd(), "uploads", "productos");

const EXTENSIONES_PERMITIDAS = [".jpg", ".jpeg", ".png", ".webp"];

const TIPOS_IMAGEN = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
};

const storage = multer.memoryStorage();

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
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
});

const guardarImagenProducto = async (req, res, next) => {
  if (!req.file) return next();

  try {
    const tipo = await fileTypeFromBuffer(req.file.buffer);
    const extensionOriginal = path.extname(req.file.originalname).toLowerCase();

    if (!tipo || !TIPOS_IMAGEN[tipo.mime] || !TIPOS_IMAGEN[tipo.mime].includes(extensionOriginal)) {
      const error = new Error("El contenido del archivo no corresponde a una imagen JPG, PNG o WEBP válida.");
      error.status = 400;
      throw error;
    }

    await mkdir(CARPETA_PRODUCTOS, { recursive: true });

    const extension = tipo.mime === "image/jpeg" ? ".jpg" : tipo.mime === "image/png" ? ".png" : ".webp";

    const filename = `producto-${req.params.id}-${Date.now()}-${randomUUID()}${extension}`;
    const filepath = path.join(CARPETA_PRODUCTOS, filename);

    await writeFile(filepath, req.file.buffer, { flag: "wx" });

    req.imagenProducto = {
      filename,
      filepath,
      url: `/uploads/productos/${filename}`,
    };

    next();
  } catch (err) {
    next(err);
  }
};

const eliminarImagenSubida = async (req) => {
  if (!req.imagenProducto?.filepath) return;

  try {
    await unlink(req.imagenProducto.filepath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
};

export { uploadImagenProducto, guardarImagenProducto, eliminarImagenSubida };
