import prisma from "../../db/prisma.js";

const listar = async (empresasId) =>
  prisma.productos.findMany({
    where: { empresas_id: empresasId, activo: true },
    orderBy: { nombre: "asc" },
    include: { recetas: { include: { insumos: true } } },
  });

const obtener = async (id, empresasId) =>
  prisma.productos.findFirst({
    where: { id, empresas_id: empresasId, activo: true },
    include: { recetas: { include: { insumos: true } } },
  });

const crear = async (empresasId, data) => prisma.productos.create({ data: { ...data, empresas_id: empresasId } });

const actualizar = async (id, data) => prisma.productos.update({ where: { id }, data });

const eliminar = async (id) => prisma.productos.update({ where: { id }, data: { activo: false } });

// ── Recetas ──────────────────────────────────────────────────────────
const sincronizarReceta = async (productosId, insumos) => {
  // insumos = [{ insumos_id, cantidad }, ...]
  // Reemplaza toda la receta del producto en una sola transacción
  return prisma.$transaction(async (tx) => {
    await tx.recetas.deleteMany({ where: { productos_id: productosId } });

    if (insumos?.length) {
      await tx.recetas.createMany({
        data: insumos.map((i) => ({
          productos_id: productosId,
          insumos_id: i.insumos_id,
          cantidad: i.cantidad,
        })),
      });
    }

    return tx.recetas.findMany({
      where: { productos_id: productosId },
      include: { insumos: true },
    });
  });
};

export { listar, obtener, crear, actualizar, eliminar, sincronizarReceta };
