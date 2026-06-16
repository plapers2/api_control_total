import { Router } from "express";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok, created, notFound, badRequest } from "../../utils/response.js";
import svc from "./clientes.service.js";

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

export default router;
