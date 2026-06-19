import prisma from "../../db/prisma.js";
import { fechaColombiaToUTC } from "../../utils/timezone.js";
import { calcularRangoPeriodo } from "../../utils/periodo.js";

const listar = async (empresasId, { periodo = "dia", page = 1, limit = 10 } = {}) => {
  const { desde, hasta } = calcularRangoPeriodo(periodo);
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    empresas_id: empresasId,
    anulado: false,
    fecha: { gte: desde, lte: hasta },
  };

  const [data, total] = await Promise.all([
    prisma.lotes_produccion.findMany({
      where,
      orderBy: { fecha: "desc" },
      skip,
      take: Number(limit),
      include: {
        usuarios: true,
        lotes_produccion_items: { include: { productos: true } },
      },
    }),
    prisma.lotes_produccion.count({ where }),
  ]);

  return { rows: data, count: total };
};

const obtener = async (id, empresasId) =>
  prisma.lotes_produccion.findFirst({
    where: { id, empresas_id: empresasId },
    include: {
      usuarios: true,
      lotes_produccion_items: { include: { productos: true } },
      movimientos_insumos: { include: { insumos: true } },
    },
  });

const crear = async (empresasId, usuariosId, { fecha, notas, items, insumos_reales }) => {
  console.log("insumos_reales recibidos:", JSON.stringify(insumos_reales));
  return prisma.$transaction(async (tx) => {
    let costoTotal = 0;
    const movimientos = [];

    if (insumos_reales && Array.isArray(insumos_reales) && insumos_reales.length > 0) {
      for (const ir of insumos_reales) {
        const insumo = await tx.insumos.findUnique({ where: { id: ir.insumos_id } });
        if (!insumo) continue;
        if (Number(insumo.stock_actual) < Number(ir.cantidad)) {
          throw new Error(
            `Insumo insuficiente: "${insumo.nombre}". Disponible: ${insumo.stock_actual} ${insumo.unidad_medida}, utilizado: ${ir.cantidad}.`,
          );
        }
      }

      for (const ir of insumos_reales) {
        if (!ir.cantidad || Number(ir.cantidad) <= 0) continue;
        const insumo = await tx.insumos.findUnique({ where: { id: ir.insumos_id } });
        if (!insumo) continue;

        const costo = Number(ir.cantidad) * Number(insumo.precio_unidad ?? 0);
        costoTotal += costo;

        movimientos.push({
          insumos_id: ir.insumos_id,
          tipo: "salida",
          cantidad: Number(ir.cantidad),
          costo_total: costo,
          nota: `Lote de produccion`,
          usuarios_id: usuariosId,
        });

        await tx.insumos.update({
          where: { id: ir.insumos_id },
          data: { stock_actual: { decrement: Number(ir.cantidad) } },
        });
      }
    } else {
      const insumosTotales = {};
      for (const item of items) {
        const recetas = await tx.recetas.findMany({
          where: { productos_id: item.productos_id },
          include: { insumos: true },
        });
        for (const r of recetas) {
          const cantidadUsada = Number(r.cantidad) * item.cantidad;
          insumosTotales[r.insumos_id] = (insumosTotales[r.insumos_id] || 0) + cantidadUsada;
        }
      }

      for (const [insumoId, cantidadNecesaria] of Object.entries(insumosTotales)) {
        const insumo = await tx.insumos.findUnique({ where: { id: Number(insumoId) } });
        if (Number(insumo.stock_actual) < cantidadNecesaria) {
          throw new Error(
            `Insumo insuficiente: "${insumo.nombre}". Disponible: ${insumo.stock_actual} ${insumo.unidad_medida}, necesario: ${cantidadNecesaria}.`,
          );
        }
      }

      for (const item of items) {
        const recetas = await tx.recetas.findMany({
          where: { productos_id: item.productos_id },
          include: { insumos: true },
        });
        for (const r of recetas) {
          const cantidadUsada = Number(r.cantidad) * item.cantidad;
          costoTotal += cantidadUsada * Number(r.insumos.precio_unidad ?? 0);
          movimientos.push({
            insumos_id: r.insumos_id,
            tipo: "salida",
            cantidad: cantidadUsada,
            costo_total: cantidadUsada * Number(r.insumos.precio_unidad ?? 0),
            nota: `Lote de produccion`,
            usuarios_id: usuariosId,
          });
          await tx.insumos.update({
            where: { id: r.insumos_id },
            data: { stock_actual: { decrement: cantidadUsada } },
          });
        }
      }
    }

    // ── Crear el lote ─────────────────────────────────────────────────
    const lote = await tx.lotes_produccion.create({
      data: {
        empresas_id: empresasId,
        usuarios_id: usuariosId,
        fecha: fechaColombiaToUTC(fecha),
        notas,
        costo_total: costoTotal,
        lotes_produccion_items: {
          create: items.map((i) => ({
            productos_id: i.productos_id,
            cantidad: i.cantidad,
            costo_unitario: 0,
          })),
        },
      },
      include: { lotes_produccion_items: true },
    });

    // ── Registrar movimientos de insumos ──────────────────────────────
    if (movimientos.length > 0) {
      await tx.movimientos_insumos.createMany({
        data: movimientos.map((m) => ({ ...m, lotes_produccion_id: lote.id })),
      });
    }

    // ── Sumar stock a productos producidos ────────────────────────────
    for (const item of items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { increment: item.cantidad } },
      });
    }

    return lote;
  });
};

const actualizar = async (id, empresasId, usuariosId, { notas, items, insumos_reales }) => {
  return prisma.$transaction(async (tx) => {
    const lote = await tx.lotes_produccion.findFirst({
      where: { id, empresas_id: empresasId, anulado: false },
      include: {
        lotes_produccion_items: true,
        movimientos_insumos: true,
      },
    });
    if (!lote) throw new Error("Lote no encontrado.");

    // Revertir stock de productos producidos anteriormente
    for (const item of lote.lotes_produccion_items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { decrement: item.cantidad } },
      });
    }

    // Devolver insumos consumidos anteriormente
    for (const mov of lote.movimientos_insumos) {
      if (mov.tipo === "salida") {
        await tx.insumos.update({
          where: { id: mov.insumos_id },
          data: { stock_actual: { increment: Number(mov.cantidad) } },
        });
      }
    }

    // Borrar items y movimientos anteriores
    await tx.lotes_produccion_items.deleteMany({ where: { lotes_produccion_id: id } });
    await tx.movimientos_insumos.deleteMany({ where: { lotes_produccion_id: id } });

    // Recalcular con los nuevos datos (misma lógica que crear)
    let costoTotal = 0;
    const movimientos = [];

    if (insumos_reales?.length) {
      for (const ir of insumos_reales) {
        const insumo = await tx.insumos.findUnique({ where: { id: ir.insumos_id } });
        if (!insumo) continue;
        if (Number(insumo.stock_actual) < Number(ir.cantidad))
          throw new Error(`Insumo insuficiente: "${insumo.nombre}". Disponible: ${insumo.stock_actual}.`);
      }
      for (const ir of insumos_reales) {
        if (!ir.cantidad || Number(ir.cantidad) <= 0) continue;
        const insumo = await tx.insumos.findUnique({ where: { id: ir.insumos_id } });
        if (!insumo) continue;
        const costo = Number(ir.cantidad) * Number(insumo.precio_unidad ?? 0);
        costoTotal += costo;
        movimientos.push({
          insumos_id: ir.insumos_id,
          tipo: "salida",
          cantidad: Number(ir.cantidad),
          costo_total: costo,
          nota: `Lote de produccion (editado)`,
          usuarios_id: usuariosId,
        });
        await tx.insumos.update({
          where: { id: ir.insumos_id },
          data: { stock_actual: { decrement: Number(ir.cantidad) } },
        });
      }
    }

    // Crear nuevos items
    await tx.lotes_produccion_items.createMany({
      data: items.map((i) => ({
        lotes_produccion_id: id,
        productos_id: i.productos_id,
        cantidad: i.cantidad,
        costo_unitario: 0,
      })),
    });

    if (movimientos.length) {
      await tx.movimientos_insumos.createMany({
        data: movimientos.map((m) => ({ ...m, lotes_produccion_id: id })),
      });
    }

    // Sumar stock nuevo
    for (const item of items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { increment: item.cantidad } },
      });
    }

    return tx.lotes_produccion.update({
      where: { id },
      data: { notas, costo_total: costoTotal },
    });
  });
};

const anular = async (id, empresasId, motivo) => {
  return prisma.$transaction(async (tx) => {
    const lote = await tx.lotes_produccion.findFirst({
      where: { id, empresas_id: empresasId, anulado: false },
      include: { lotes_produccion_items: true, movimientos_insumos: true },
    });
    if (!lote) throw new Error("Lote no encontrado o ya anulado.");

    // Revertir stock de productos
    for (const item of lote.lotes_produccion_items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { decrement: item.cantidad } },
      });
    }

    // Devolver insumos
    for (const mov of lote.movimientos_insumos) {
      if (mov.tipo === "salida") {
        await tx.insumos.update({
          where: { id: mov.insumos_id },
          data: { stock_actual: { increment: Number(mov.cantidad) } },
        });
      }
    }

    return tx.lotes_produccion.update({
      where: { id },
      data: { anulado: true, motivo_anulacion: motivo },
    });
  });
};

export { listar, obtener, crear, actualizar, anular };
