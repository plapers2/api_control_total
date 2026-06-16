import prisma from "../../db/prisma.js";

// ── GET /empresas ────────────────────────────────────────────────────
// Lista las empresas a las que pertenece el usuario autenticado
const listarMisEmpresas = async (usuarioId) => {
  return prisma.usuarios_empresas.findMany({
    where: { usuarios_id: usuarioId, activo: true },
    include: { empresas: true, roles: true },
  });
};

// ── POST /empresas ───────────────────────────────────────────────────
// Crea una empresa y vuelve admin automáticamente al usuario que la crea
const crearEmpresa = async ({ nombre, descripcion, usuarioId }) => {
  const rolAdmin = await prisma.roles.findUnique({ where: { nombre: "admin" } });
  if (!rolAdmin) {
    const error = new Error('No existe el rol "admin". Revisa el seed de roles.');
    error.status = 500;
    throw error;
  }

  // $transaction: si cualquiera de las dos operaciones falla, ninguna se aplica.
  const empresa = await prisma.$transaction(async (tx) => {
    const nuevaEmpresa = await tx.empresas.create({
      data: { nombre, descripcion },
    });

    await tx.usuarios_empresas.create({
      data: {
        usuarios_id: usuarioId,
        empresas_id: nuevaEmpresa.id,
        roles_id: rolAdmin.id,
      },
    });

    return nuevaEmpresa;
  });

  return empresa;
};

// ── GET /empresas/:id ─────────────────────────────────────────────────
const obtenerEmpresa = async (id) => {
  const empresa = await prisma.empresas.findUnique({
    where: { id },
    include: {
      usuarios_empresas: {
        where: { activo: true },
        include: { usuarios: true, roles: true },
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
    include: { usuarios: true, roles: true },
  });
};

// ── POST /empresas/:id/miembros ──────────────────────────────────────
// upsert = "actualiza si existe, crea si no" (equivalente a findOrCreate + update)
const agregarMiembro = async (empresasId, { usuarios_id, roles_id }) => {
  return prisma.usuarios_empresas.upsert({
    where: {
      usuarios_id_empresas_id: { usuarios_id, empresas_id: empresasId },
    },
    create: {
      usuarios_id,
      empresas_id: empresasId,
      roles_id,
      activo: true,
    },
    update: {
      roles_id,
      activo: true,
    },
  });
};

// ── DELETE /empresas/:id/miembros/:userId ────────────────────────────
// Soft-delete: en vez de borrar la fila, la marcamos como inactiva.
const removerMiembro = async (empresasId, usuariosId) => {
  return prisma.usuarios_empresas.update({
    where: {
      usuarios_id_empresas_id: { usuarios_id: usuariosId, empresas_id: empresasId },
    },
    data: { activo: false },
  });
};

export { listarMisEmpresas, crearEmpresa, obtenerEmpresa, actualizarEmpresa, listarMiembros, agregarMiembro, removerMiembro };
