import { Router } from "express";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok, created, notFound, badRequest } from "../../utils/response.js";
import * as svc from "./produccion.service.js";
import { requireRol } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(authenticate, requireEmpresa);

router.get("/", async (req, res, next) => {
  try {
    return ok(res, await svc.listar(req.empresas_id));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const lote = await svc.obtener(Number(req.params.id), req.empresas_id);
    if (!lote) return notFound(res);
    return ok(res, lote);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { fecha, notas, items, insumos_reales } = req.body;
    if (!fecha || !Array.isArray(items) || !items.length) return badRequest(res, "fecha e items son requeridos.");

    const lote = await svc.crear(req.empresas_id, req.usuario.id, { fecha, notas, items, insumos_reales });
    return created(res, lote);
  } catch (err) {
    if (err.message?.includes("insuficiente") || err.message?.includes("Stock")) {
      return badRequest(res, err.message);
    }
    next(err);
  }
});

router.put("/:id", requireRol("admin"), async (req, res, next) => {
  try {
    const { notas, items, insumos_reales } = req.body;
    if (!Array.isArray(items) || !items.length) return badRequest(res, "items es requerido.");
    const lote = await svc.actualizar(Number(req.params.id), req.empresas_id, req.usuario.id, { notas, items, insumos_reales });
    return ok(res, lote);
  } catch (err) {
    if (err.message?.includes("insuficiente")) return badRequest(res, err.message);
    next(err);
  }
});

router.delete("/:id", requireRol("admin"), async (req, res, next) => {
  try {
    const { motivo } = req.body;
    if (!motivo?.trim()) return badRequest(res, "El motivo de anulación es requerido.");
    await svc.anular(Number(req.params.id), req.empresas_id, motivo);
    return ok(res, null, "Lote anulado.");
  } catch (err) {
    next(err);
  }
});

export default router;
