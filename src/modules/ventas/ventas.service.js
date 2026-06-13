const prisma = require("../../db/prisma");

const listar = async (empresasId) =>
  prisma.ventas.findMany({
    where: { empresas_id: empresasId },
    orderBy: { fecha: "desc" },
    include: {
      clientes: true,
      usuarios: true,
      ventas_items: { include: { productos: true } },
    },
  });

const obtener = async (id, empresasId) =>
  prisma.ventas.findFirst({
    where: { id, empresas_id: empresasId },
    include: {
      clientes: true,
      usuarios: true,
      ventas_items: { include: { productos: true } },
      movimientos_caja: true,
    },
  });

const crear = async (empresasId, usuariosId, { fecha, canal, notas, clientes_id, items }) => {
  return prisma.$transaction(async (tx) => {
    // Validar stock de cada producto
    for (const item of items) {
      const producto = await tx.productos.findFirst({
        where: { id: item.productos_id, empresas_id: empresasId },
      });
      if (!producto) throw new Error(`Producto ${item.productos_id} no encontrado.`);
      if (Number(producto.stock_actual) < item.cantidad) {
        throw new Error(`Stock insuficiente para "${producto.nombre}". Disponible: ${producto.stock_actual}.`);
      }
    }

    const total = items.reduce((sum, i) => sum + Number(i.precio_unitario) * i.cantidad, 0);

    const venta = await tx.ventas.create({
      data: {
        empresas_id: empresasId,
        usuarios_id: usuariosId,
        clientes_id: clientes_id ?? null,
        canal: canal ?? "punto_venta",
        fecha: new Date(fecha),
        notas,
        total,
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

    // Descontar stock de productos
    for (const item of items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { decrement: item.cantidad } },
      });
    }

    // Movimiento de caja automático
    await tx.movimientos_caja.create({
      data: {
        empresas_id: empresasId,
        usuarios_id: usuariosId,
        ventas_id: venta.id,
        tipo: "ingreso",
        categoria: "venta",
        monto: total,
        descripcion: `Venta #${venta.id}`,
        fecha: new Date(fecha),
      },
    });

    return venta;
  });
};

module.exports = { listar, obtener, crear };
