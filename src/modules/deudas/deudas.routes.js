import { Router } from "express";
import { leerPaginacion } from "../../utils/paginacion.js";
import { authenticate, requireEmpresa } from "../../middlewares/auth.middleware.js";
import { ok, created, badRequest, paginate } from "../../utils/response.js";
import * as svc from "./deudas.service.js";

const router = Router();
router.use(authenticate, requireEmpresa);

// GET /deudas?page=1&limit=10
router.get("/", async (req, res, next) => {
  try {
    const { page, limit } = leerPaginacion(req.query);
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
    const { monto, nota, fecha, guardar_excedente } = req.body;
    if (!monto || !fecha) return badRequest(res, "monto y fecha son requeridos.");

    const pago = await svc.registrarPago(Number(req.params.ventaId), req.empresas_id, req.usuario.id, {
      monto: Number(monto),
      nota,
      fecha,
      guardar_excedente: !!guardar_excedente,
    });
    return created(res, pago, "Abono registrado.");
  } catch (err) {
    // Los errores con status (400/404) los responde el errorHandler con su mensaje
    next(err);
  }
});

const leerClienteId = (req) => {
  const id = Number(req.params.clientesId);
  return Number.isInteger(id) && id >= 0 ? id : null;
};

// GET /deudas/clientes  (una fila por cliente con su deuda total)
router.get("/clientes", async (req, res, next) => {
  try {
    return ok(res, await svc.listarPorCliente(req.empresas_id));
  } catch (err) {
    next(err);
  }
});

// GET /deudas/clientes/:clientesId  (compras pendientes, la más vieja primero; 0 = sin cliente)
router.get("/clientes/:clientesId", async (req, res, next) => {
  try {
    const clientesId = leerClienteId(req);
    if (clientesId === null) return badRequest(res, "Cliente inválido.");
    return ok(res, await svc.detalleCliente(clientesId, req.empresas_id));
  } catch (err) {
    next(err);
  }
});

// POST /deudas/clientes/:clientesId/pagos  (abono general, de la deuda más vieja a la más reciente)
router.post("/clientes/:clientesId/pagos", async (req, res, next) => {
  try {
    const clientesId = leerClienteId(req);
    if (clientesId === null) return badRequest(res, "Cliente inválido.");
    const { monto, nota, fecha } = req.body;
    if (!monto || !fecha) return badRequest(res, "monto y fecha son requeridos.");

    const resultado = await svc.registrarPagoCliente(clientesId, req.empresas_id, req.usuario.id, {
      monto: Number(monto),
      nota,
      fecha,
    });
    return created(res, resultado, "Abono registrado.");
  } catch (err) {
    next(err);
  }
});

export default router;
