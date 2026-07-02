import { Router } from "express";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok, created, notFound, badRequest } from "../../utils/response.js";
import * as svc from "./clientes.service.js";

const router = Router();

router.use(authenticate, requireEmpresa);

router.get("/", async (req, res, next) => {
  try {
    return ok(res, await svc.listar(req.empresas_id));
  } catch (err) {
    next(err);
  }
});

// GET /clientes/inactivos?dias=15 — clientes activos con más de N días sin comprar.
// Debe ir antes de "/:id" para que "inactivos" no se interprete como un id.
router.get("/inactivos", async (req, res, next) => {
  try {
    const dias = req.query.dias ? Number(req.query.dias) : 15;
    return ok(res, await svc.listarInactivos(req.empresas_id, dias));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const c = await svc.obtener(Number(req.params.id), req.empresas_id);
    if (!c) return notFound(res);
    return ok(res, c);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { nombre, telefono, direccion, notas } = req.body;
    if (!nombre) return badRequest(res, "nombre es requerido.");
    return created(res, await svc.crear(req.empresas_id, { nombre, telefono, direccion, notas }));
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const { nombre, telefono, direccion, notas, activo } = req.body;
    return ok(res, await svc.actualizar(Number(req.params.id), { nombre, telefono, direccion, notas, activo }));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await svc.eliminar(Number(req.params.id));
    return ok(res, null, "Cliente desactivado.");
  } catch (err) {
    next(err);
  }
});

// PATCH /clientes/:id/aviso — marcar (o desmarcar) que ya se envió el aviso de inactividad
router.patch("/:id/aviso", async (req, res, next) => {
  try {
    const { enviado } = req.body;
    const c = await svc.marcarAviso(Number(req.params.id), req.empresas_id, !!enviado);
    return ok(res, c, enviado ? "Marcado como enviado." : "Marcado como pendiente.");
  } catch (err) {
    if (err.message?.includes("no encontrado")) return notFound(res, err.message);
    next(err);
  }
});

export default router;
