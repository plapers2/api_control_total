import { Router } from "express";
import { authenticate, requireEmpresa, requireRol } from "../../middlewares/auth.middleware.js";
import { ok, badRequest } from "../../utils/response.js";
import * as svc from "./servicios-publicos.service.js";

const router = Router();
router.use(authenticate, requireEmpresa);

router.get("/", async (req, res, next) => {
  try { return ok(res, await svc.resumen(req.empresas_id)); }
  catch (err) { next(err); }
});

router.put("/configuracion", requireRol("admin"), async (req, res, next) => {
  try {
    const { servicio, dia_pago } = req.body;
    if (!servicio || dia_pago === undefined || dia_pago === null || dia_pago === "") return badRequest(res, "servicio y dia_pago son requeridos.");
    return ok(res, await svc.guardarConfiguracion(req.empresas_id, { servicio, dia_pago }));
  } catch (err) { next(err); }
});

export default router;
