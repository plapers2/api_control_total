import { Router } from "express";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok, created, notFound, badRequest } from "../../utils/response.js";
import * as svc from "./insumos.service.js";

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
    const insumo = await svc.obtener(Number(req.params.id), req.empresas_id);
    if (!insumo) return notFound(res);
    return ok(res, insumo);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { nombre, unidad_medida, stock_actual, stock_minimo, precio_unidad } = req.body;
    if (!nombre || !unidad_medida) return badRequest(res, "nombre y unidad_medida son requeridos.");
    const insumo = await svc.crear(req.empresas_id, { nombre, unidad_medida, stock_actual, stock_minimo, precio_unidad });
    return created(res, insumo);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const { nombre, unidad_medida, stock_actual, stock_minimo, precio_unidad, activo } = req.body;
    const insumo = await svc.actualizar(Number(req.params.id), req.empresas_id, {
      nombre,
      unidad_medida,
      stock_actual,
      stock_minimo,
      precio_unidad,
      activo,
    });
    return ok(res, insumo);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await svc.eliminar(Number(req.params.id));
    return ok(res, null, "Insumo desactivado.");
  } catch (err) {
    next(err);
  }
});

export default router;
