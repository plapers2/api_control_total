import { noEncontrado } from "../../utils/errors.js";

const actualizar = async (id, empresasId, data) => {
  const { count } = await prisma.productos.updateMany({
    where: { id, empresas_id: empresasId },
    data,
  });
  if (count === 0) throw noEncontrado("Producto no encontrado.");
  return prisma.productos.findFirst({ where: { id, empresas_id: empresasId } });
};

const eliminar = async (id, empresasId) => {
  const { count } = await prisma.productos.updateMany({
    where: { id, empresas_id: empresasId },
    data: { activo: false },
  });
  if (count === 0) throw noEncontrado("Producto no encontrado.");
};

const sincronizarReceta = async (productosId, empresasId, insumos) => {
  // El producto debe ser de esta empresa
  const producto = await prisma.productos.findFirst({
    where: { id: productosId, empresas_id: empresasId },
    select: { id: true },
  });
  if (!producto) throw noEncontrado("Producto no encontrado.");

  // Todos los insumos de la receta deben ser de esta empresa
  const ids = [...new Set(insumos.map((i) => Number(i.insumos_id)))];
  if (ids.length) {
    const validos = await prisma.insumos.count({
      where: { id: { in: ids }, empresas_id: empresasId },
    });
    if (validos !== ids.length) {
      const error = new Error("Uno o más insumos no existen en esta empresa.");
      error.status = 400;
      throw error;
    }
  }

  return prisma.$transaction(async (tx) => {
    await tx.recetas.deleteMany({ where: { productos_id: productosId } });

    if (insumos.length) {
      await tx.recetas.createMany({
        data: insumos.map((i) => ({
          productos_id: productosId,
          insumos_id: Number(i.insumos_id),
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
