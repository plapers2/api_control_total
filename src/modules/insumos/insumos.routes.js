import { Router } from "express";
import { noNegativo } from "../../utils/numeros.js";
import { authenticate, requireEmpresa, requireRol } from "../../middlewares/auth.middleware.js";
import { ok, created, notFound, badRequest } from "../../utils/response.js";
import * as svc from "./insumos.service.js";

const router = Router();

const numeroEntradaValido = (valor) =>
  (typeof valor === "number" || typeof valor === "string") &&
  String(valor).trim() !== "" &&
  Number.isFinite(Number(valor));

router.use(authenticate, requireEmpresa);

router.get("/", async (req, res, next) => {
  try {
    return ok(res, await svc.listar(req.empresas_id));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/ajuste", requireRol("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { stock_real, motivo } = req.body;

    if (!Number.isInteger(id) || id <= 0) {
      return badRequest(res, "ID de insumo inválido.");
    }

    if (
      !numeroEntradaValido(stock_real) ||
      Number(stock_real) < 0
    ) {
      return badRequest(res, "stock_real debe ser un número válido y no negativo.");
    }

    if (typeof motivo !== "string" || !motivo.trim() || motivo.trim().length > 180) {
      return badRequest(res, "El motivo es obligatorio y no puede superar 180 caracteres.");
    }

    const resultado = await svc.ajustarInventario(
      id,
      req.empresas_id,
      req.usuario.id,
      Number(stock_real),
      motivo,
    );

    return ok(res, resultado);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/conciliacion", requireRol("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { stock_real, valor_total, motivo } = req.body;

    if (!Number.isInteger(id) || id <= 0) {
      return badRequest(res, "ID de insumo inválido.");
    }

    if (
      !numeroEntradaValido(stock_real) ||
      Number(stock_real) < 0
    ) {
      return badRequest(res, "stock_real debe ser un número válido y no negativo.");
    }

    if (
      !numeroEntradaValido(valor_total) ||
      Number(valor_total) < 0
    ) {
      return badRequest(res, "valor_total debe ser un número válido y no negativo.");
    }

    if (typeof motivo !== "string" || !motivo.trim() || motivo.trim().length > 180) {
      return badRequest(res, "El motivo es obligatorio y no puede superar 180 caracteres.");
    }

    const resultado = await svc.conciliarInventario(
      id,
      req.empresas_id,
      req.usuario.id,
      Number(stock_real),
      Number(valor_total),
      motivo,
    );

    return created(res, resultado);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/conciliaciones", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return badRequest(res, "ID de insumo inválido.");
    }

    return ok(res, await svc.listarConciliaciones(id, req.empresas_id));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const insumo = await svc.obtener(id, req.empresas_id);
    if (!insumo) return notFound(res);
    return ok(res, insumo);
  } catch (err) {
    next(err);
  }
});

router.post("/", requireRol("admin"), async (req, res, next) => {
  try {
    const { nombre, unidad_medida, stock_actual, stock_minimo, precio_unidad } = req.body;
    if (!nombre || !unidad_medida) {
      return badRequest(res, "nombre y unidad_medida son requeridos.");
    }

    if (![stock_actual, stock_minimo, precio_unidad].every(noNegativo)) {
      return badRequest(res, "Stock y precio deben ser números válidos, no negativos.");
    }

    const insumo = await svc.crear(req.empresas_id, {
      nombre,
      unidad_medida,
      stock_actual,
      stock_minimo,
      precio_unidad,
    });

    return created(res, insumo);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireRol("admin"), async (req, res, next) => {
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

router.delete("/:id", requireRol("admin"), async (req, res, next) => {
  try {
    await svc.eliminar(Number(req.params.id), req.empresas_id);
    return ok(res, null, "Insumo desactivado.");
  } catch (err) {
    next(err);
  }
});

export default router;
