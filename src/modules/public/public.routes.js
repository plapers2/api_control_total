import { Router } from "express";
import { ok, notFound } from "../../utils/response.js";
import * as svc from "./public.service.js";

// Rutas SIN autenticación — solo exponen lo mínimo necesario para la página
// pública de promoción de productos (nombre/descripción de la empresa y el
// catálogo de productos activos). No exponer nada más aquí.
const router = Router();

router.get("/empresa", async (req, res, next) => {
  try {
    const empresa = await svc.obtenerEmpresa();
    if (!empresa) return notFound(res);
    return ok(res, empresa);
  } catch (err) {
    next(err);
  }
});

router.get("/productos", async (req, res, next) => {
  try {
    const productos = await svc.listarProductos();
    return ok(res, productos);
  } catch (err) {
    next(err);
  }
});

export default router;
