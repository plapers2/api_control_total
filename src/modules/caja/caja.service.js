import prisma from "../../db/prisma.js";
import { calcularRangoPeriodo } from "../../utils/periodo.js";

const listar = async (empresasId, { periodo = "dia", tipo, categoria, page = 1, limit = 10 } = {}) => {
  const { desde, hasta } = calcularRangoPeriodo(periodo);
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    empresas_id: empresasId,
    fecha: { gte: desde, lte: hasta },
    ...(tipo && { tipo }),
    ...(categoria && { categoria }),
  };

  const [rows, count] = await Promise.all([
    prisma.movimientos_caja.findMany({
      where,
      orderBy: [{ fecha: "desc" }, { created_at: "desc" }],
      skip,
      take: Number(limit),
      include: { usuarios: true, ventas: true },
    }),
    prisma.movimientos_caja.count({ where }),
  ]);

  return { rows, count };
};

const resumen = async (empresasId, { desde, hasta } = {}) => {
  const where = {
    empresas_id: empresasId,
    ...(desde &&
      hasta && {
        fecha: { gte: new Date(desde), lte: new Date(hasta) },
      }),
  };

  const [ingresos, gastos] = await Promise.all([
    prisma.movimientos_caja.aggregate({
      where: { ...where, tipo: "ingreso" },
      _sum: { monto: true },
    }),
    prisma.movimientos_caja.aggregate({
      where: { ...where, tipo: "gasto" },
      _sum: { monto: true },
    }),
  ]);

  const totalIngresos = Number(ingresos._sum.monto ?? 0);
  const totalGastos = Number(gastos._sum.monto ?? 0);

  return {
    ingresos: totalIngresos,
    gastos: totalGastos,
    balance: totalIngresos - totalGastos,
  };
};

// Registro manual (gastos, ajustes, etc.)
const registrar = async (empresasId, usuariosId, { tipo, categoria, monto, descripcion, fecha }) =>
  prisma.movimientos_caja.create({
    data: {
      empresas_id: empresasId,
      usuarios_id: usuariosId,
      tipo,
      categoria,
      monto,
      descripcion,
      fecha: new Date(fecha),
    },
  });

export { listar, resumen, registrar };
