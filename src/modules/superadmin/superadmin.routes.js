import { Router } from "express";
import { authenticate, requireSuperadmin } from "../../middlewares/auth.middleware.js";
import { ok, created, badRequest } from "../../utils/response.js";
import * as svc from "./superadmin.service.js";

const router = Router();
router.use(authenticate, requireSuperadmin);

// GET /superadmin/empresas
router.get("/empresas", async (req, res, next) => {
  try {
    return ok(res, await svc.listarEmpresas());
  } catch (err) {
    next(err);
  }
});

// POST /superadmin/empresas
// Body: { nombre, descripcion?, admin: { usuarios_id } | { nombre, email } }
router.post("/empresas", async (req, res, next) => {
  try {
    const { nombre, descripcion, admin } = req.body;
    if (!nombre?.trim()) return badRequest(res, "El nombre de la empresa es requerido.");
    if (!admin) return badRequest(res, "Debes indicar el admin de la empresa.");

    const esExistente = !!admin.usuarios_id;
    const esNuevo = !!admin.nombre?.trim() && !!admin.email?.trim();
    if (!esExistente && !esNuevo) {
      return badRequest(res, "admin debe traer usuarios_id, o nombre y email para crear uno nuevo.");
    }

    const data = await svc.crearEmpresaConAdmin({ nombre: nombre.trim(), descripcion, admin });
    return created(res, data, "Empresa creada.");
  } catch (err) {
    next(err);
  }
});

export default router;
