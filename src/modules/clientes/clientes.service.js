import prisma from "../../db/prisma.js";

const MS_POR_DIA = 1000 * 60 * 60 * 24;

const listar = async (empresasId) =>
  prisma.clientes.findMany({
    where: { empresas_id: empresasId, activo: true },
    orderBy: { nombre: "asc" },
  });

const obtener = async (id, empresasId) => prisma.clientes.findFirst({ where: { id, empresas_id: empresasId, activo: true } });

const crear = async (empresasId, data) => prisma.clientes.create({ data: { ...data, empresas_id: empresasId } });

const actualizar = async (id, data) => prisma.clientes.update({ where: { id }, data });

const eliminar = async (id) => prisma.clientes.update({ where: { id }, data: { activo: false } });

// Clientes activos con más de `dias` días sin comprar (o que nunca han comprado).
// Trae, por cada cliente, solo su venta más reciente no anulada (take: 1),
// así el cálculo de "última compra" se hace con una sola ida a la BD sin
// importar cuántas ventas tenga el histórico de cada cliente.
const listarInactivos = async (empresasId, dias = 15) => {
  const clientes = await prisma.clientes.findMany({
    where: { empresas_id: empresasId, activo: true },
    include: {
      ventas: {
        where: { anulada: false },
        orderBy: { fecha: "desc" },
        take: 1,
        select: { fecha: true },
      },
    },
  });

  const ahora = Date.now();
  const umbralMs = Number(dias) * MS_POR_DIA;

  return clientes
    .map((c) => {
      const ultimaCompra = c.ventas[0]?.fecha ?? null;
      const fechaReferencia = ultimaCompra ?? c.created_at;
      const diasSinComprar = Math.floor((ahora - new Date(fechaReferencia).getTime()) / MS_POR_DIA);

      return {
        id: c.id,
        nombre: c.nombre,
        telefono: c.telefono,
        direccion: c.direccion,
        ultima_compra: ultimaCompra,
        nunca_compro: !ultimaCompra,
        dias_sin_comprar: diasSinComprar,
        aviso_inactivo_enviado: c.aviso_inactivo_enviado,
        aviso_inactivo_enviado_at: c.aviso_inactivo_enviado_at,
      };
    })
    .filter((c) => c.dias_sin_comprar >= Number(dias))
    .sort((a, b) => b.dias_sin_comprar - a.dias_sin_comprar);
};

const marcarAviso = async (id, empresasId, enviado) => {
  const cliente = await prisma.clientes.findFirst({ where: { id, empresas_id: empresasId } });
  if (!cliente) throw new Error("Cliente no encontrado.");

  return prisma.clientes.update({
    where: { id },
    data: {
      aviso_inactivo_enviado: enviado,
      aviso_inactivo_enviado_at: enviado ? new Date() : null,
    },
  });
};

export { listar, obtener, crear, actualizar, eliminar, listarInactivos, marcarAviso };
