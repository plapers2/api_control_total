import prisma from "../../db/prisma.js";

const listar = async (empresasId) => {
  const where = { empresas_id: empresasId, activo: true };

  const [rows, count] = await Promise.all([
    prisma.productos.findMany({
      where,
      orderBy: { nombre: "asc" },
      include: { recetas: { include: { insumos: true } } },
    }),
    prisma.productos.count({ where }),
  ]);

  return { rows, count };
};

const obtener = async (id, empresasId) =>
  prisma.productos.findFirst({
    where: { id, empresas_id: empresasId, activo: true },
    include: { recetas: { include: { insumos: true } } },
  });

const crear = async (empresasId, data) => prisma.productos.create({ data: { ...data, empresas_id: empresasId } });

const actualizar = async (id, data) => prisma.productos.update({ where: { id }, data });

const eliminar = async (id) => prisma.productos.update({ where: { id }, data: { activo: false } });

// ── Historial de inventario (entradas y salidas) ──────────────────────
// No existe una tabla de movimientos de producto terminado (a diferencia de
// insumos, que sí tiene movimientos_insumos). El historial se arma
// combinando las dos fuentes que realmente mueven stock_actual de un
// producto: las ventas (salida) y los lotes de producción (entrada).
const historial = async (id, empresasId, { page = 1, limit = 15 } = {}) => {
  const [ventasItems, loteItems] = await Promise.all([
    prisma.ventas_items.findMany({
      where: { productos_id: id, ventas: { empresas_id: empresasId } },
      include: { ventas: true },
    }),
    prisma.lotes_produccion_items.findMany({
      where: { productos_id: id, lotes_produccion: { empresas_id: empresasId } },
      include: { lotes_produccion: true },
    }),
  ]);

  const movimientos = [
    ...ventasItems.map((vi) => ({
      tipo: "salida",
      cantidad: vi.cantidad,
      fecha: vi.ventas.fecha,
      created_at: vi.ventas.created_at,
      referencia: `Venta #${vi.ventas_id}`,
      anulado: vi.ventas.anulada,
    })),
    ...loteItems.map((li) => ({
      tipo: "entrada",
      cantidad: li.cantidad,
      fecha: li.lotes_produccion.fecha,
      created_at: li.lotes_produccion.created_at,
      referencia: `Lote de producción #${li.lotes_produccion_id}`,
      anulado: li.lotes_produccion.anulado,
    })),
  ];

  movimientos.sort((a, b) => new Date(b.fecha) - new Date(a.fecha) || new Date(b.created_at) - new Date(a.created_at));

  const count = movimientos.length;
  const skip = (Number(page) - 1) * Number(limit);
  const rows = movimientos.slice(skip, skip + Number(limit));

  return { rows, count };
};

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

export { listar, obtener, crear, actualizar, eliminar, sincronizarReceta, historial };
