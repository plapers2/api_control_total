const router = require("express").Router();
const { authenticate } = require("../../middlewares/auth.middleware");
const { ok, created, badRequest } = require("../../utils/response");
const authService = require("./auth.service");

// ── POST /auth/register ─────────────────────────────────────────────
router.post("/register", async (req, res, next) => {
  try {
    const { nombre, email, password } = req.body;
    if (!nombre || !email || !password) {
      return badRequest(res, "nombre, email y password son requeridos.");
    }

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

// ── POST /auth/select-empresa ──────────────────────────────────────────
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

module.exports = router;
