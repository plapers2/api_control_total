import { Router } from "express";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok, created, badRequest, paginate } from "../../utils/response.js";
import * as svc from "./caja.service.js";
import { requireRol } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(authenticate, requireEmpresa);

// GET /caja?periodo=dia|semana|mes|total&desde=YYYY-MM-DD&hasta=YYYY-MM-DD&tipo=ingreso&categoria=venta&page=1&limit=10
// - periodo=total (o "todo") trae todo lo registrado históricamente, sin filtro de fecha.
// - desde/hasta (ambos) definen un rango personalizado y tienen prioridad sobre periodo.
router.get("/", async (req, res, next) => {
  try {
    const { periodo, desde, hasta, tipo, categoria, page, limit } = req.query;
    const { rows, count } = await svc.listar(req.empresas_id, { periodo, desde, hasta, tipo, categoria, page, limit });
    return paginate(res, rows, count, page || 1, limit || 10);
  } catch (err) {
    next(err);
  }
});

// GET /caja/resumen?periodo=dia|semana|mes|total  (o desde=...&hasta=... para un rango exacto)
// Siempre incluye, además del resumen del periodo pedido, el balance histórico
// total (balanceTotal/ingresosTotal/gastosTotal) con todo lo registrado en el
// sistema, para poder mostrarlo permanentemente sin importar el filtro activo.
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
    const { tipo, categoria, monto, descripcion, fecha, insumos, tipo_servicio } = req.body;
    if (!tipo || !categoria || !monto || !fecha) return badRequest(res, "tipo, categoria, monto y fecha son requeridos.");
    if (categoria === "servicio_publico" && !["energia", "agua", "gas"].includes(tipo_servicio)) {
      return badRequest(res, "tipo_servicio (energia, agua o gas) es requerido cuando la categoría es servicio_publico.");
    }

    const mov = await svc.registrar(req.empresas_id, req.usuario.id, {
      tipo,
      categoria,
      tipo_servicio,
      monto,
      descripcion,
      fecha,
      insumos: Array.isArray(insumos)
        ? insumos.map((i) => ({ insumos_id: Number(i.insumos_id), cantidad: Number(i.cantidad) }))
        : undefined,
    });
    return created(res, mov);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireRol("admin"), async (req, res, next) => {
  try {
    const { tipo, categoria, monto, descripcion, fecha, tipo_servicio } = req.body;
    if (!tipo || !categoria || !monto || !fecha) return badRequest(res, "tipo, categoria, monto y fecha son requeridos.");
    if (categoria === "servicio_publico" && !["energia", "agua", "gas"].includes(tipo_servicio)) {
      return badRequest(res, "tipo_servicio (energia, agua o gas) es requerido cuando la categoría es servicio_publico.");
    }
    const mov = await svc.actualizar(Number(req.params.id), req.empresas_id, { tipo, categoria, monto, descripcion, fecha, tipo_servicio });
    return ok(res, mov);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireRol("admin"), async (req, res, next) => {
  try {
    const { motivo } = req.body;
    if (!motivo?.trim()) return badRequest(res, "El motivo de anulación es requerido.");
    await svc.anular(Number(req.params.id), req.empresas_id, motivo);
    return ok(res, null, "Movimiento anulado.");
  } catch (err) {
    next(err);
  }
});

export default router;
