import prisma from "../../db/prisma.js";

const listar = async (empresasId) =>
  prisma.insumos.findMany({
    where: { empresas_id: empresasId, activo: true },
    orderBy: { nombre: "asc" },
  });

const obtener = async (id, empresasId) => prisma.insumos.findFirst({ where: { id, empresas_id: empresasId, activo: true } });

const crear = async (empresasId, data) => prisma.insumos.create({ data: { ...data, empresas_id: empresasId } });

const actualizar = async (id, empresasId, data) =>
  prisma.insumos.update({
    where: { id },
    data,
  });

const eliminar = async (id) => prisma.insumos.update({ where: { id }, data: { activo: false } });

export { listar, obtener, crear, actualizar, eliminar };
