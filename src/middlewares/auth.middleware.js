const jwt = require("jsonwebtoken");
const prisma = require("../db/prisma");

/**
 * Verifica el JWT y adjunta req.usuario.
 * Si el token trae empresas_id en el payload, también adjunta req.membresia
 * con el rol del usuario en esa empresa.
 */
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Token no proporcionado." });
    }

    const token = header.split(" ")[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const usuario = await prisma.usuarios.findFirst({
      where: { id: payload.id, activo: true },
    });
    if (!usuario) {
      return res.status(401).json({ message: "Usuario no encontrado o inactivo." });
    }

    // No exponemos el hash de password en req.usuario
    const { password, ...usuarioSinPassword } = usuario;
    req.usuario = usuarioSinPassword;

    // Si el token incluye empresas_id, cargar la membresía + rol
    if (payload.empresas_id) {
      const membresia = await prisma.usuarios_empresas.findFirst({
        where: {
          usuarios_id: usuario.id,
          empresas_id: payload.empresas_id,
          activo: true,
        },
        include: { roles: true },
      });

      if (!membresia) {
        return res.status(403).json({ message: "Sin acceso a esta empresa." });
      }

      req.membresia = membresia;
      req.empresas_id = payload.empresas_id;
    }

    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expirado." });
    }
    return res.status(401).json({ message: "Token inválido." });
  }
};

/**
 * Requiere que el token tenga empresas_id (empresa seleccionada).
 * Usar después de authenticate.
 */
const requireEmpresa = (req, res, next) => {
  if (!req.empresas_id || !req.membresia) {
    return res.status(403).json({ message: "Debes seleccionar una empresa primero." });
  }
  next();
};

/**
 * Fábrica de middleware para restringir por rol.
 * Uso: requireRol('admin')
 */
const requireRol =
  (...rolesPermitidos) =>
  (req, res, next) => {
    if (!req.membresia) {
      return res.status(403).json({ message: "Sin empresa seleccionada." });
    }
    const rolActual = req.membresia.roles?.nombre;
    if (!rolesPermitidos.includes(rolActual)) {
      return res.status(403).json({ message: "No tienes permisos para esta acción." });
    }
    next();
  };

module.exports = { authenticate, requireEmpresa, requireRol };
