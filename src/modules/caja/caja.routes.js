import { Router } from "express";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok, created, badRequest, paginate } from "../../utils/response.js";
import * as svc from "./caja.service.js";

const router = Router();

router.use(authenticate, requireEmpresa);

// GET /caja?periodo=dia|semana|mes&tipo=ingreso&categoria=venta&page=1&limit=10
router.get("/", async (req, res, next) => {
  try {
    const { periodo, tipo, categoria, page, limit } = req.query;
    const { rows, count } = await svc.listar(req.empresas_id, { periodo, tipo, categoria, page, limit });
    return paginate(res, rows, count, page || 1, limit || 10);
  } catch (err) {
    next(err);
  }
});

// GET /caja/resumen?periodo=dia|semana|mes  (o desde=...&hasta=... si necesitas un rango exacto)
router.get("/resumen", async (req, res, next) => {
  try {
    const { periodo, desde, hasta } = req.query;
    return ok(res, await svc.resumen(req.empresas_id, { periodo, desde, hasta }));
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