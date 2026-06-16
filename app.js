import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";

import prisma from "./src/db/prisma.js";
import errorHandler from "./src/middlewares/errorHandler.js";

// ── Importar rutas de cada módulo ───────────────────────────────────
import authRoutes from "./src/modules/auth/auth.routes.js";
import empresasRoutes from "./src/modules/empresas/empresas.routes.js";
import insumosRoutes from "./src/modules/insumos/insumos.routes.js";
import productosRoutes from "./src/modules/productos/productos.routes.js";
import produccionRoutes from "./src/modules/produccion/produccion.routes.js";
import clientesRoutes from "./src/modules/clientes/clientes.routes.js";
import ventasRoutes from "./src/modules/ventas/ventas.routes.js";
import cajaRoutes from "./src/modules/caja/caja.routes.js";

const app = express();

// ── Middlewares globales ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ── Rutas ────────────────────────────────────────────────────────────
const API = "/api";
app.use(`${API}/auth`, authRoutes);
app.use(`${API}/empresas`, empresasRoutes);
app.use(`${API}/insumos`, insumosRoutes);
app.use(`${API}/productos`, productosRoutes);
app.use(`${API}/produccion`, produccionRoutes);
app.use(`${API}/clientes`, clientesRoutes);
app.use(`${API}/ventas`, ventasRoutes);
app.use(`${API}/caja`, cajaRoutes);

// ── Health check ─────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date() }));

// ── 404 ──────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ message: "Ruta no encontrada." }));

// ── Error handler global ────────────────────────────────────────────
app.use(errorHandler);

// ── Arrancar servidor ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await prisma.$connect();
    console.log("✅ Conexión a la BD establecida (Prisma).");
    app.listen(PORT, () => {
      console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
      console.log(`📡 API base: http://localhost:${PORT}${API}`);
    });
  } catch (err) {
    console.error("❌ No se pudo conectar a la BD:", err);
    process.exit(1);
  }
})();

export default app;