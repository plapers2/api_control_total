import { Router } from "express";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok } from "../../utils/response.js";
import * as svc from "./rentabilidad.service.js";
import { primerRegistro } from "./primerRegistro.service.js";

const router = Router();

router.use(authenticate, requireEmpresa);

// GET /reportes/rentabilidad?periodo=dia|semana|mes|total&desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Mismo filtro que ya usan Home/Caja/Producción (FiltroPeriodo en el frontend).
router.get("/rentabilidad", async (req, res, next) => {
  try {
    const { periodo, desde, hasta } = req.query;
    return ok(res, await svc.rentabilidad(req.empresas_id, { periodo, desde, hasta }));
  } catch (err) {
    next(err);
  }
});

// GET /reportes/primer-registro?modulo=ventas|caja|produccion
// Fecha del registro más antiguo (no anulado). El calendario de la app la usa
// para no dejar elegir días en los que no hay nada. Sin "modulo" mira los tres.
router.get("/primer-registro", async (req, res, next) => {
  try {
    return ok(res, await primerRegistro(req.empresas_id, req.query.modulo));
  } catch (err) {
    next(err);
  }
});

export default router;