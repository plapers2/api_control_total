import { Router } from "express";
import { authenticate, requireEmpresa, requireRol } from "../../middlewares/auth.middleware.js";
import { ok, created, badRequest } from "../../utils/response.js";
import * as authService from "./auth.service.js";

const router = Router();

// ── POST /auth/register ─────────────────────────────────────────────
router.post("/register", async (req, res, next) => {
  try {
    const { nombre, email, password } = req.body;
    if (!nombre || !email || !password) return badRequest(res, "nombre, email y password son requeridos.");
    const data = await authService.registrar({ nombre, email, password });
    return created(res, data, "Registro exitoso.");
  } catch (err) {
    next(err);
  }
});

// ── POST /auth/login ─────────────────────────────────────────────────
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return badRequest(res, "email y password son requeridos.");
    const data = await authService.login({ email, password });
    return ok(res, data);
  } catch (err) {
    next(err);
  }
});

// ── POST /auth/select-empresa ────────────────────────────────────────
router.post("/select-empresa", authenticate, async (req, res, next) => {
  try {
    const { empresas_id } = req.body;
    if (!empresas_id) return badRequest(res, "empresas_id es requerido.");
    const data = await authService.seleccionarEmpresa({
      usuarioId: req.usuario.id,
      empresasId: empresas_id,
    });
    return ok(res, data);
  } catch (err) {
    next(err);
  }
});

// ── GET /auth/me ─────────────────────────────────────────────────────
router.get("/me", authenticate, async (req, res, next) => {
  try {
    const data = await authService.obtenerPerfil(req.usuario.id);
    return ok(res, { usuario: req.usuario, ...data });
  } catch (err) {
    next(err);
  }
});

// ── GET /auth/usuarios — listar miembros (admin) ─────────────────────
router.get("/usuarios", authenticate, requireEmpresa, requireRol("admin"), async (req, res, next) => {
  try {
    return ok(res, await authService.listarMiembros(req.empresas_id));
  } catch (err) {
    next(err);
  }
});

// ── POST /auth/usuarios — crear empleado (admin) ─────────────────────
router.post("/usuarios", authenticate, requireEmpresa, requireRol("admin"), async (req, res, next) => {
  try {
    const { nombre, email, password, rol } = req.body;
    if (!nombre || !email || !password) return badRequest(res, "nombre, email y password son requeridos.");
    const data = await authService.crearEmpleado({
      nombre,
      email,
      password,
      empresasId: req.empresas_id,
      rolNombre: rol || "empleado",
    });
    return created(res, data);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /auth/usuarios/:id — desactivar miembro (admin) ───────────
router.delete("/usuarios/:id", authenticate, requireEmpresa, requireRol("admin"), async (req, res, next) => {
  try {
    await authService.desactivarMiembro(Number(req.params.id), req.empresas_id);
    return ok(res, null, "Miembro desactivado.");
  } catch (err) {
    next(err);
  }
});

export default router;
