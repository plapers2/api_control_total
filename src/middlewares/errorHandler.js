const { Prisma } = require("../../generated/prisma");

/**
 * Middleware global de manejo de errores.
 * Debe ser el último middleware registrado en app.js
 */
const errorHandler = (err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ERROR:`, err);

  // Errores conocidos de Prisma
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      // Violación de restricción UNIQUE (ej: email duplicado)
      case "P2002": {
        const campos = err.meta?.target || [];
        return res.status(422).json({
          message: "Ya existe un registro con ese valor.",
          campos,
        });
      }
      // Violación de llave foránea (ej: empresas_id que no existe)
      case "P2003":
        return res.status(422).json({ message: "Referencia inválida: el registro relacionado no existe." });

      // Registro no encontrado (ej: update/delete sobre un id inexistente)
      case "P2025":
        return res.status(404).json({ message: "Recurso no encontrado." });

      default:
        break;
    }
  }

  // Error de validación de datos (tipos incorrectos, campos faltantes, etc.)
  if (err instanceof Prisma.PrismaClientValidationError) {
    return res.status(422).json({ message: "Datos inválidos para esta operación." });
  }

  const status = err.status || 500;
  const message = status < 500 ? err.message : "Error interno del servidor.";
  res.status(status).json({ message });
};

module.exports = errorHandler;
