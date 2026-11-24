import { Router } from "express";
import { authenticate, requireRol } from "../../middlewares/auth.middleware.js";
import { ok, created, noContent, notFound, badRequest } from "../../utils/response.js";
import * as empresasService from "./empresas.service.js";

const router = Router();

router.use(authenticate);

// Las rutas /empresas/:id/* solo se pueden usar sobre LA empresa del token.
// requireRol("admin") solo mira el rol en la empresa del token, no el :id de la
// URL: sin esta comprobación, un admin de la empresa A podía editar la B o
// agregarse como admin de ella.
const soloMiEmpresa = (req, res, next) => {
  if (!req.empresas_id || Number(req.params.id) !== req.empresas_id) {
    return res.status(403).json({ message: "No puedes administrar otra empresa." });
  }
  next();
};

// ── GET /empresas ────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const data = await empresasService.listarMisEmpresas(req.usuario.id);
    return ok(res, data);
  } catch (err) {
    next(err);
  }
});

// ── GET /empresas/:id ─────────────────────────────────────────────────
router.get("/:id", soloMiEmpresa, async (req, res, next) => {
  try {
    const empresa = await empresasService.obtenerEmpresa(Number(req.params.id));
    if (!empresa) return notFound(res);
    return ok(res, empresa);
  } catch (err) {
    next(err);
  }
});

// ── PUT /empresas/:id ─────────────────────────────────────────────────
router.put("/:id", soloMiEmpresa, requireRol("admin"), async (req, res, next) => {
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
router.get("/:id/miembros", soloMiEmpresa, requireRol("admin"), async (req, res, next) => {
  try {
    const data = await empresasService.listarMiembros(Number(req.params.id));
    return ok(res, data);
  } catch (err) {
    next(err);
  }
});

// ── POST /empresas/:id/miembros ──────────────────────────────────────
router.post("/:id/miembros", soloMiEmpresa, requireRol("admin"), async (req, res, next) => {
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
router.delete("/:id/miembros/:userId", soloMiEmpresa, requireRol("admin"), async (req, res, next) => {
  try {
    await empresasService.removerMiembro(Number(req.params.id), Number(req.params.userId));
    return noContent(res);
  } catch (err) {
    next(err);
  }
});

export default router;
