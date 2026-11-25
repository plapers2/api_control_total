import prisma from "../../db/prisma.js";

// ── GET /empresas ────────────────────────────────────────────────────
// Lista las empresas a las que pertenece el usuario autenticado
const listarMisEmpresas = async (usuarioId) => {
  return prisma.usuarios_empresas.findMany({
    where: { usuarios_id: usuarioId, activo: true },
    include: { empresas: true, roles: true },
  });
};

// ── GET /empresas/:id ─────────────────────────────────────────────────
const obtenerEmpresa = async (id) => {
  const empresa = await prisma.empresas.findUnique({
    where: { id },
    include: {
      usuarios_empresas: {
        where: { activo: true },
        include: { usuarios: { select: { id: true, nombre: true, email: true, activo: true } }, roles: true },
      },
    },
  });

  if (!empresa) return null;

  // Transformamos usuarios_empresas -> miembros (igual que el "as: miembros" viejo)
  const { usuarios_empresas, ...resto } = empresa;
  const miembros = usuarios_empresas.map((ue) => ({
    ...ue.usuarios,
    rol: ue.roles?.nombre,
  }));

  return { ...resto, miembros };
};

// ── PUT /empresas/:id ─────────────────────────────────────────────────
const actualizarEmpresa = async (id, { nombre, descripcion, activa }) => {
  // Si alguno viene undefined, Prisma simplemente no lo incluye en el UPDATE.
  return prisma.empresas.update({
    where: { id },
    data: { nombre, descripcion, activa },
  });
};

// ── GET /empresas/:id/miembros ───────────────────────────────────────
const listarMiembros = async (empresasId) => {
  return prisma.usuarios_empresas.findMany({
    where: { empresas_id: empresasId },
    include: { usuarios: { select: { id: true, nombre: true, email: true, activo: true } }, roles: true },
  });
};

// ── POST /empresas/:id/miembros ──────────────────────────────────────
// upsert = "actualiza si existe, crea si no" (equivalente a findOrCreate + update)

const agregarMiembro = async (empresasId, { usuarios_id, roles_id }, usuarioActualId) => {
  const usuarioId = Number(usuarios_id);
  const rolId = Number(roles_id);

  if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
    throw Object.assign(new Error("El usuario indicado no es válido."), { status: 400 });
  }

  if (!Number.isInteger(rolId) || rolId <= 0) {
    throw Object.assign(new Error("El rol indicado no es válido."), { status: 400 });
  }

  const [usuario, rol] = await Promise.all([
    prisma.usuarios.findUnique({
      where: { id: usuarioId },
      select: { id: true, activo: true },
    }),
    prisma.roles.findUnique({
      where: { id: rolId },
      select: { id: true, nombre: true },
    }),
  ]);

  if (!usuario || !usuario.activo) {
    throw Object.assign(new Error("El usuario no existe o está inactivo."), { status: 400 });
  }

  if (!rol || !["admin", "empleado"].includes(rol.nombre)) {
    throw Object.assign(new Error("El rol indicado no es válido."), { status: 400 });
  }

  // El administrador no puede quitarse su propio rol de administrador.
  if (usuarioId === usuarioActualId && rol.nombre !== "admin") {
    throw Object.assign(new Error("No puedes quitarte tu propio rol de administrador."), { status: 400 });
  }

  return prisma.usuarios_empresas.upsert({
    where: {
      usuarios_id_empresas_id: {
        usuarios_id: usuarioId,
        empresas_id: empresasId,
      },
    },
    create: {
      usuarios_id: usuarioId,
      empresas_id: empresasId,
      roles_id: rol.id,
      activo: true,
    },
    update: {
      roles_id: rol.id,
      activo: true,
    },
  });
};

// ── DELETE /empresas/:id/miembros/:userId ────────────────────────────
// Soft-delete: en vez de borrar la fila, la marcamos como inactiva.
const removerMiembro = async (empresasId, usuariosId, usuarioActualId) => {
  if (usuariosId === usuarioActualId) {
    throw Object.assign(new Error("No puedes quitarte a ti mismo de la empresa."), { status: 400 });
  }
  return prisma.usuarios_empresas.update({
    where: {
      usuarios_id_empresas_id: { usuarios_id: usuariosId, empresas_id: empresasId },
    },
    data: { activo: false },
  });
};

export { listarMisEmpresas, obtenerEmpresa, actualizarEmpresa, listarMiembros, agregarMiembro, removerMiembro };
