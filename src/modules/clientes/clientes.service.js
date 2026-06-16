import prisma from "../../db/prisma.js";

const listar = async (empresasId) =>
  prisma.clientes.findMany({
    where: { empresas_id: empresasId },
    orderBy: { nombre: "asc" },
  });

const obtener = async (id, empresasId) => prisma.clientes.findFirst({ where: { id, empresas_id: empresasId } });

const crear = async (empresasId, data) => prisma.clientes.create({ data: { ...data, empresas_id: empresasId } });

const actualizar = async (id, data) => prisma.clientes.update({ where: { id }, data });

const eliminar = async (id) => prisma.clientes.update({ where: { id }, data: { activo: false } });

export { listar, obtener, crear, actualizar, eliminar };
