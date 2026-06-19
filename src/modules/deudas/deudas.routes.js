import { Router } from "express";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok, created, badRequest, paginate } from "../../utils/response.js";
import * as svc from "./deudas.service.js";

const router = Router();
router.use(authenticate, requireEmpresa);

// GET /deudas?page=1&limit=10
router.get("/", async (req, res, next) => {
  try {
    const { page, limit } = req.query;
    const { rows, count } = await svc.listar(req.empresas_id, { page, limit });
    return paginate(res, rows, count, page || 1, limit || 10);
  } catch (err) {
    next(err);
  }
});

// GET /deudas/resumen
router.get("/resumen", async (req, res, next) => {
  try {
    return ok(res, await svc.resumen(req.empresas_id));
  } catch (err) {
    next(err);
  }
});

// POST /deudas/:ventaId/pagos
router.post("/:ventaId/pagos", async (req, res, next) => {
  try {
    const { monto, nota, fecha } = req.body;
    if (!monto || !fecha) return badRequest(res, "monto y fecha son requeridos.");

    const pago = await svc.registrarPago(Number(req.params.ventaId), req.empresas_id, req.usuario.id, {
      monto: Number(monto),
      nota,
      fecha,
    });
    return created(res, pago, "Abono registrado.");
  } catch (err) {
    if (
      err.message?.includes("saldo") ||
      err.message?.includes("pagada") ||
      err.message?.includes("encontrada") ||
      err.message?.includes("mayor a 0")
    ) {
      return badRequest(res, err.message);
    }
    next(err);
  }
});

export default router;
