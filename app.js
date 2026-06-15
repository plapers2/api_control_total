require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const prisma = require("./src/db/prisma");
const errorHandler = require("./src/middlewares/errorHandler");

// ── Importar rutas de cada módulo ───────────────────────────────────
const authRoutes = require("./src/modules/auth/auth.routes");
const empresasRoutes = require("./src/modules/empresas/empresas.routes");
const insumosRoutes = require("./src/modules/insumos/insumos.routes");
const productosRoutes = require("./src/modules/productos/productos.routes");
const produccionRoutes = require("./src/modules/produccion/produccion.routes");
const clientesRoutes = require("./src/modules/clientes/clientes.routes");
const ventasRoutes = require("./src/modules/ventas/ventas.routes");
const cajaRoutes = require("./src/modules/caja/caja.routes");

const app = express();

// ── Middlewares globales ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ── Rutas ────────────────────────────────────────────────────────────
const API = "/api/v1";
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

module.exports = app;
