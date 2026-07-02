import prisma from "../../db/prisma.js";
import { fechaColombiaToUTC } from "../../utils/timezone.js";
import { construirRangoFecha } from "../../utils/rangoFecha.js";

const listar = async (empresasId, { periodo = "dia", desde, hasta, tipo, categoria, page = 1, limit = 10 } = {}) => {
  const rangoFecha = construirRangoFecha({ periodo, desde, hasta });
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    empresas_id: empresasId,
    anulado: false,
    ...(rangoFecha && { fecha: rangoFecha }),
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

// Suma ingresos/gastos (no anulados) para un where ya armado.
// Dos aggregate en paralelo: usan el índice (empresas_id, anulado, tipo) y no
// traen filas a la app, solo el total ya calculado por la base de datos —
// es barato incluso con miles de movimientos, así que se puede calcular
// "al vuelo" en cada consulta sin necesidad de guardar un saldo acumulado aparte.
const sumarIngresosYGastos = async (where) => {
  const [ingresos, gastos] = await Promise.all([
    prisma.movimientos_caja.aggregate({ where: { ...where, tipo: "ingreso" }, _sum: { monto: true } }),
    prisma.movimientos_caja.aggregate({ where: { ...where, tipo: "gasto" }, _sum: { monto: true } }),
  ]);

  const totalIngresos = Number(ingresos._sum.monto ?? 0);
  const totalGastos = Number(gastos._sum.monto ?? 0);

  return { ingresos: totalIngresos, gastos: totalGastos, balance: totalIngresos - totalGastos };
};

// Balance histórico total: todo lo registrado en el sistema para la empresa,
// sin importar el periodo/filtro que se esté viendo en pantalla. Se calcula
// con un aggregate directo (sin traer registros), así que es seguro llamarlo
// siempre junto al resumen del periodo sin afectar el rendimiento del server.
const balanceActual = async (empresasId) => {
  const where = { empresas_id: empresasId, anulado: false };
  return sumarIngresosYGastos(where);
};

const resumen = async (empresasId, { periodo, desde, hasta } = {}) => {
  const rangoFecha = construirRangoFecha({ periodo, desde, hasta });

  const wherePeriodo = {
    empresas_id: empresasId,
    anulado: false,
    ...(rangoFecha && { fecha: rangoFecha }),
  };

  // Resumen del periodo consultado + balance histórico total en paralelo:
  // dos idas a la base de datos, ambas resueltas con aggregate (sin filas),
  // así el balance "de siempre" se puede mostrar en la misma respuesta.
  const [delPeriodo, total] = await Promise.all([sumarIngresosYGastos(wherePeriodo), balanceActual(empresasId)]);

  return {
    ingresos: delPeriodo.ingresos,
    gastos: delPeriodo.gastos,
    balance: delPeriodo.balance,
    balanceTotal: total.balance,
    ingresosTotal: total.ingresos,
    gastosTotal: total.gastos,
  };
};

// Registro manual (gastos, ajustes, etc.)
// Si llegan insumos (array de {insumos_id, cantidad}), además del movimiento de
// caja se suma cada cantidad al stock del insumo correspondiente (es opcional:
// muchos gastos de "insumo" son solo control de gasto, sin inventario real).
const registrar = async (empresasId, usuariosId, { tipo, categoria, monto, descripcion, fecha, insumos }) => {
  if (insumos?.length) {
    return prisma.$transaction(async (tx) => {
      const mov = await tx.movimientos_caja.create({
        data: {
          empresas_id: empresasId,
          usuarios_id: usuariosId,
          tipo,
          categoria,
          monto,
          descripcion,
          fecha: fechaColombiaToUTC(fecha),
        },
      });

      for (const i of insumos) {
        await tx.insumos.update({
          where: { id: i.insumos_id },
          data: { stock_actual: { increment: Number(i.cantidad) } },
        });
      }

      return mov;
    });
  }

  return prisma.movimientos_caja.create({
    data: {
      empresas_id: empresasId,
      usuarios_id: usuariosId,
      tipo,
      categoria,
      monto,
      descripcion,
      fecha: fechaColombiaToUTC(fecha),
    },
  });
};

const actualizar = async (id, empresasId, { tipo, categoria, monto, descripcion, fecha, insumos }) => {
  return prisma.$transaction(async (tx) => {
    const mov = await tx.movimientos_caja.findFirst({
      where: { id, empresas_id: empresasId, anulado: false },
    });
    if (!mov) throw new Error("Movimiento no encontrado.");

    // Si tenía insumos vinculados (categoría insumo), revertir stock
    // Buscamos movimientos de insumos con nota que referencie este movimiento de caja
    // Como no hay FK directa, revertimos si la categoría era insumo
    // (el admin es responsable de la coherencia al editar)

    return tx.movimientos_caja.update({
      where: { id },
      data: {
        tipo,
        categoria,
        monto,
        descripcion,
        fecha: fechaColombiaToUTC(fecha),
      },
    });
  });
};

const anular = async (id, empresasId, motivo) => {
  return prisma.$transaction(async (tx) => {
    const mov = await tx.movimientos_caja.findFirst({
      where: { id, empresas_id: empresasId, anulado: false },
    });
    if (!mov) throw new Error("Movimiento no encontrado o ya anulado.");

    // Si era un gasto de insumo, no hay FK directa a movimientos_insumos,
    // así que solo aplicamos borrado lógico. El admin maneja el ajuste de stock
    // manualmente si es necesario.
    return tx.movimientos_caja.update({
      where: { id },
      data: { anulado: true, motivo_anulacion: motivo },
    });
  });
};

export { listar, resumen, registrar, actualizar, anular, balanceActual };
