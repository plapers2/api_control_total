import { Router } from "express";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok } from "../../utils/response.js";
import * as svc from "./rentabilidad.service.js";

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

export default router;
