import prisma from "../../db/prisma.js";
import { calcularRangoPeriodo } from "../../utils/periodo.js";

const listar = async (empresasId, { periodo = "dia", page = 1, limit = 10 } = {}) => {
  const { desde, hasta } = calcularRangoPeriodo(periodo);
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    empresas_id: empresasId,
    anulada: false,
    fecha: { gte: desde, lte: hasta },
  };

  const [rows, count] = await Promise.all([
    prisma.ventas.findMany({
      where,
      orderBy: [{ fecha: "desc" }, { created_at: "desc" }],
      skip,
      take: Number(limit),
      include: { clientes: true, usuarios: true, ventas_items: { include: { productos: true } } },
    }),
    prisma.ventas.count({ where }),
  ]);

  return { rows, count };
};

const obtener = async (id, empresasId) =>
  prisma.ventas.findFirst({
    where: { id, empresas_id: empresasId },
    include: {
      clientes: true,
      usuarios: true,
      ventas_items: { include: { productos: true } },
      movimientos_caja: true,
      pagos_venta: true,
    },
  });

const crear = async (empresasId, usuariosId, { fecha, canal, notas, clientes_id, items, credito, abono_inicial }) => {
  return prisma.$transaction(async (tx) => {
    for (const item of items) {
      const producto = await tx.productos.findFirst({
        where: { id: item.productos_id, empresas_id: empresasId, activo: true },
      });
      if (!producto) throw new Error(`Producto ${item.productos_id} no encontrado.`);
      if (Number(producto.stock_actual) < item.cantidad)
        throw new Error(`Stock insuficiente para "${producto.nombre}". Disponible: ${producto.stock_actual}.`);
    }

    const total = items.reduce((sum, i) => sum + Number(i.precio_unitario) * i.cantidad, 0);
    const esCredito = !!credito;
    const montoAbono = esCredito ? Math.min(Number(abono_inicial || 0), total) : total;
    const estadoPago = !esCredito || montoAbono >= total ? "pagada" : montoAbono > 0 ? "parcial" : "pendiente";

    const venta = await tx.ventas.create({
      data: {
        empresas_id: empresasId,
        usuarios_id: usuariosId,
        clientes_id: clientes_id ?? null,
        canal: canal ?? "punto_venta",
        fecha: new Date(fecha),
        notas,
        total,
        estado_pago: estadoPago,
        ventas_items: {
          create: items.map((i) => ({
            productos_id: i.productos_id,
            cantidad: i.cantidad,
            precio_unitario: i.precio_unitario,
            subtotal: Number(i.precio_unitario) * i.cantidad,
          })),
        },
      },
      include: { ventas_items: true },
    });

    for (const item of items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { decrement: item.cantidad } },
      });
    }

    if (montoAbono > 0) {
      await tx.movimientos_caja.create({
        data: {
          empresas_id: empresasId,
          usuarios_id: usuariosId,
          ventas_id: venta.id,
          tipo: "ingreso",
          categoria: "venta",
          monto: montoAbono,
          descripcion: estadoPago === "pagada" ? `Venta #${venta.id}` : `Abono inicial venta #${venta.id}`,
          fecha: new Date(fecha),
        },
      });

      if (esCredito && estadoPago !== "pagada") {
        await tx.pagos_venta.create({
          data: {
            ventas_id: venta.id,
            usuarios_id: usuariosId,
            monto: montoAbono,
            fecha: new Date(fecha),
            nota: "Abono inicial",
          },
        });
      }
    }

    return venta;
  });
};

const actualizar = async (id, empresasId, usuariosId, { canal, notas, items }) => {
  return prisma.$transaction(async (tx) => {
    const venta = await tx.ventas.findFirst({
      where: { id, empresas_id: empresasId, anulada: false },
      include: { ventas_items: true },
    });
    if (!venta) throw new Error("Venta no encontrada.");

    // Revertir stock de items anteriores
    for (const item of venta.ventas_items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { increment: item.cantidad } },
      });
    }

    // Validar stock con nuevos items
    for (const item of items) {
      const producto = await tx.productos.findFirst({
        where: { id: item.productos_id, empresas_id: empresasId, activo: true },
      });
      if (!producto) throw new Error(`Producto ${item.productos_id} no encontrado.`);
      if (Number(producto.stock_actual) < item.cantidad)
        throw new Error(`Stock insuficiente para "${producto.nombre}". Disponible: ${producto.stock_actual}.`);
    }

    const nuevoTotal = items.reduce((sum, i) => sum + Number(i.precio_unitario) * i.cantidad, 0);

    // Reemplazar items
    await tx.ventas_items.deleteMany({ where: { ventas_id: id } });
    await tx.ventas_items.createMany({
      data: items.map((i) => ({
        ventas_id: id,
        productos_id: i.productos_id,
        cantidad: i.cantidad,
        precio_unitario: i.precio_unitario,
        subtotal: Number(i.precio_unitario) * i.cantidad,
      })),
    });

    // Descontar stock con nuevos items
    for (const item of items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { decrement: item.cantidad } },
      });
    }

    // Actualizar movimiento de caja vinculado
    const movCaja = await tx.movimientos_caja.findFirst({
      where: { ventas_id: id, anulado: false },
    });
    if (movCaja) {
      await tx.movimientos_caja.update({
        where: { id: movCaja.id },
        data: { monto: nuevoTotal, descripcion: `Venta #${id} (editada)` },
      });
    }

    return tx.ventas.update({
      where: { id },
      data: { canal, notas, total: nuevoTotal },
    });
  });
};

const anular = async (id, empresasId, usuariosId, motivo) => {
  return prisma.$transaction(async (tx) => {
    const venta = await tx.ventas.findFirst({
      where: { id, empresas_id: empresasId, anulada: false },
      include: { ventas_items: true },
    });
    if (!venta) throw new Error("Venta no encontrada o ya anulada.");

    // Devolver stock
    for (const item of venta.ventas_items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { increment: item.cantidad } },
      });
    }

    // Anular movimientos de caja vinculados
    await tx.movimientos_caja.updateMany({
      where: { ventas_id: id },
      data: { anulado: true, motivo_anulacion: motivo },
    });

    return tx.ventas.update({
      where: { id },
      data: { anulada: true, motivo_anulacion: motivo },
    });
  });
};

export { listar, obtener, crear, actualizar, anular };
