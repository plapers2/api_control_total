import prisma from "../../db/prisma.js";
import { noEncontrado } from "../../utils/errors.js";

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

export { listar, obtener, crear, actualizar, eliminar, sincronizarReceta, historial };
