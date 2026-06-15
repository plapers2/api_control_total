const prisma = require("../../db/prisma");

const listar = async (empresasId) =>
  prisma.lotes_produccion.findMany({
    where: { empresas_id: empresasId },
    orderBy: { fecha: "desc" },
    include: {
      usuarios: true,
      lotes_produccion_items: { include: { productos: true } },
    },
  });

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
        fecha: new Date(fecha),
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

module.exports = { listar, obtener, crear };
