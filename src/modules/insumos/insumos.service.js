import prisma from "../../db/prisma.js";
import { noEncontrado } from "../../utils/errors.js";

const listar = async (empresasId) =>
  prisma.insumos.findMany({
    where: { empresas_id: empresasId, activo: true },
    orderBy: { nombre: "asc" },
  });

const obtener = async (id, empresasId) =>
  prisma.insumos.findFirst({
    where: { id, empresas_id: empresasId, activo: true },
    include: {
      recetas: {
        include: { productos: true },
      },
    },
  });

const crear = async (empresasId, data) => prisma.insumos.create({ data: { ...data, empresas_id: empresasId } });

const actualizar = async (id, empresasId, data) => {
  const { count } = await prisma.insumos.updateMany({
    where: { id, empresas_id: empresasId },
    data,
  });
  if (count === 0) throw noEncontrado("Insumo no encontrado.");
  return prisma.insumos.findFirst({ where: { id, empresas_id: empresasId } });
};

const eliminar = async (id, empresasId) => {
  const { count } = await prisma.insumos.updateMany({
    where: { id, empresas_id: empresasId },
    data: { activo: false },
  });
  if (count === 0) throw noEncontrado("Insumo no encontrado.");
};

export { listar, obtener, crear, actualizar, eliminar };
