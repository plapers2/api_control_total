import { Router } from "express";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok, created, notFound, badRequest, paginate } from "../../utils/response.js";
import * as svc from "./productos.service.js";

const router = Router();

router.use(authenticate, requireEmpresa);

router.get("/", async (req, res, next) => {
  try {
    const { periodo, page, limit } = req.query;
    const { rows, count } = await svc.listar(req.empresas_id, { periodo, page, limit });
    return paginate(res, rows, count, page || 1, limit || 10);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const p = await svc.obtener(Number(req.params.id), req.empresas_id);
    if (!p) return notFound(res);
    return ok(res, p);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { nombre, descripcion, precio_venta } = req.body;
    if (!nombre) return badRequest(res, "nombre es requerido.");
    const p = await svc.crear(req.empresas_id, { nombre, descripcion, precio_venta });
    return created(res, p);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const { nombre, descripcion, precio_venta, activo } = req.body;
    const p = await svc.actualizar(Number(req.params.id), { nombre, descripcion, precio_venta, activo });
    return ok(res, p);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await svc.eliminar(Number(req.params.id));
    return ok(res, null, "Producto desactivado.");
  } catch (err) {
    next(err);
  }
});

// ── PUT /productos/:id/receta ─────────────────────────────────────────
// Reemplaza la receta completa del producto
router.put("/:id/receta", async (req, res, next) => {
  try {
    const { insumos } = req.body;
    if (!Array.isArray(insumos)) return badRequest(res, "insumos debe ser un array.");
    const receta = await svc.sincronizarReceta(Number(req.params.id), insumos);
    return ok(res, receta);
  } catch (err) {
    next(err);
  }
});

export default router;
