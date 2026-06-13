/**
 * Helpers para respuestas HTTP consistentes.
 */

const ok = (res, data, message = "OK", status = 200) => res.status(status).json({ message, data });

const created = (res, data, message = "Creado exitosamente.") => res.status(201).json({ message, data });

const noContent = (res) => res.status(204).send();

const notFound = (res, message = "Recurso no encontrado.") => res.status(404).json({ message });

const badRequest = (res, message = "Solicitud inválida.") => res.status(400).json({ message });

const forbidden = (res, message = "Acceso denegado.") => res.status(403).json({ message });

const paginate = (res, rows, count, page, limit) =>
  res.status(200).json({
    message: "OK",
    data: rows,
    meta: {
      total: count,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(count / limit),
    },
  });

module.exports = { ok, created, noContent, notFound, badRequest, forbidden, paginate };
