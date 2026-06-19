import { Router } from "express";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok, created, notFound, badRequest, paginate } from "../../utils/response.js";
import * as svc from "./ventas.service.js";

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
    const v = await svc.obtener(Number(req.params.id), req.empresas_id);
    if (!v) return notFound(res);
    return ok(res, v);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { fecha, canal, notas, clientes_id, items } = req.body;
    if (!fecha || !Array.isArray(items) || !items.length) return badRequest(res, "fecha e items son requeridos.");

    const venta = await svc.crear(req.empresas_id, req.usuario.id, { fecha, canal, notas, clientes_id, items });
    return created(res, venta);
  } catch (err) {
    if (err.message?.includes("insuficiente") || err.message?.includes("Stock")) {
      return badRequest(res, err.message);
    }
    next(err);
  }
});

export default router;
