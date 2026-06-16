import { Router } from "express";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok, created, badRequest } from "../../utils/response.js";
import svc from "./caja.service.js";

const router = Router();

router.use(authenticate, requireEmpresa);

// GET /caja?fecha=2026-06-13&tipo=ingreso&categoria=venta
router.get("/", async (req, res, next) => {
  try {
    const { fecha, tipo, categoria } = req.query;
    return ok(res, await svc.listar(req.empresas_id, { fecha, tipo, categoria }));
  } catch (err) {
    next(err);
  }
});

// GET /caja/resumen?desde=2026-06-01&hasta=2026-06-30
router.get("/resumen", async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    return ok(res, await svc.resumen(req.empresas_id, { desde, hasta }));
  } catch (err) {
    next(err);
  }
});

// POST /caja — registro manual (gastos, etc.)
router.post("/", async (req, res, next) => {
  try {
    const { tipo, categoria, monto, descripcion, fecha } = req.body;
    if (!tipo || !categoria || !monto || !fecha) return badRequest(res, "tipo, categoria, monto y fecha son requeridos.");

    const mov = await svc.registrar(req.empresas_id, req.usuario.id, {
      tipo,
      categoria,
      monto,
      descripcion,
      fecha,
    });
    return created(res, mov);
  } catch (err) {
    next(err);
  }
});

export default router;