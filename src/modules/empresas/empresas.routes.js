import { Router } from "express";
import { authenticate, requireRol } from "../../middlewares/auth.middleware.js";
import { ok, created, noContent, notFound, badRequest } from "../../utils/response.js";
import * as empresasService from "./empresas.service.js";

const router = Router();

router.use(authenticate);

// ── GET /empresas ────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const data = await empresasService.listarMisEmpresas(req.usuario.id);
    return ok(res, data);
  } catch (err) {
    next(err);
  }
});

// ── POST /empresas ───────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const { nombre, descripcion } = req.body;
    if (!nombre) return badRequest(res, "El nombre de la empresa es requerido.");

    const empresa = await empresasService.crearEmpresa({
      nombre,
      descripcion,
      usuarioId: req.usuario.id,
    });
    return created(res, empresa);
  } catch (err) {
    next(err);
  }
});

// ── GET /empresas/:id ─────────────────────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const empresa = await empresasService.obtenerEmpresa(Number(req.params.id));
    if (!empresa) return notFound(res);
    return ok(res, empresa);
  } catch (err) {
    next(err);
  }
});

// ── PUT /empresas/:id ─────────────────────────────────────────────────
router.put("/:id", requireRol("admin"), async (req, res, next) => {
  try {
    const { nombre, descripcion, activa } = req.body;
    const empresa = await empresasService.actualizarEmpresa(Number(req.params.id), {
      nombre,
      descripcion,
      activa,
    });
    return ok(res, empresa);
  } catch (err) {
    next(err);
  }
});

// ── GET /empresas/:id/miembros ───────────────────────────────────────
router.get("/:id/miembros", requireRol("admin"), async (req, res, next) => {
  try {
    const data = await empresasService.listarMiembros(Number(req.params.id));
    return ok(res, data);
  } catch (err) {
    next(err);
  }
});

// ── POST /empresas/:id/miembros ──────────────────────────────────────
router.post("/:id/miembros", requireRol("admin"), async (req, res, next) => {
  try {
    const { usuarios_id, roles_id } = req.body;
    if (!usuarios_id || !roles_id) {
      return badRequest(res, "usuarios_id y roles_id son requeridos.");
    }

    const membresia = await empresasService.agregarMiembro(Number(req.params.id), {
      usuarios_id,
      roles_id,
    });
    return created(res, membresia);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /empresas/:id/miembros/:userId ────────────────────────────
router.delete("/:id/miembros/:userId", requireRol("admin"), async (req, res, next) => {
  try {
    await empresasService.removerMiembro(Number(req.params.id), Number(req.params.userId));
    return noContent(res);
  } catch (err) {
    next(err);
  }
});

export default router;
