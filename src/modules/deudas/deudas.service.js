import prisma from "../../db/prisma.js";

const calcularSaldo = (venta) => {
  const pagado = venta.pagos_venta.reduce((s, p) => s + Number(p.monto), 0);
  return Number(venta.total) - pagado;
};

const listar = async (empresasId, { page = 1, limit = 10 } = {}) => {
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    empresas_id: empresasId,
    estado_pago: { in: ["pendiente", "parcial"] },
  };

  const [rows, count] = await Promise.all([
    prisma.ventas.findMany({
      where,
      orderBy: [{ fecha: "desc" }, { created_at: "desc" }],
      skip,
      take: Number(limit),
      include: { clientes: true, pagos_venta: true },
    }),
    prisma.ventas.count({ where }),
  ]);

  const data = rows.map((v) => ({
    ...v,
    pagado: v.pagos_venta.reduce((s, p) => s + Number(p.monto), 0),
    saldo: calcularSaldo(v),
  }));

  return { rows: data, count };
};

const resumen = async (empresasId) => {
  const ventas = await prisma.ventas.findMany({
    where: { empresas_id: empresasId, estado_pago: { in: ["pendiente", "parcial"] } },
    include: { pagos_venta: true },
  });

  const totalPorCobrar = ventas.reduce((s, v) => s + calcularSaldo(v), 0);

  return { totalPorCobrar, cantidadVentas: ventas.length };
};

const registrarPago = async (ventaId, empresasId, usuariosId, { monto, nota, fecha }) => {
  return prisma.$transaction(async (tx) => {
    const venta = await tx.ventas.findFirst({
      where: { id: ventaId, empresas_id: empresasId },
      include: { pagos_venta: true },
    });
    if (!venta) throw new Error("Venta no encontrada.");
    if (venta.estado_pago === "pagada") throw new Error("Esta venta ya está pagada por completo.");

    const pagadoActual = venta.pagos_venta.reduce((s, p) => s + Number(p.monto), 0);
    const saldo = Number(venta.total) - pagadoActual;

    if (monto <= 0) throw new Error("El monto del abono debe ser mayor a 0.");
    if (monto > saldo) throw new Error(`El abono no puede ser mayor al saldo pendiente (${saldo}).`);

    const pago = await tx.pagos_venta.create({
      data: {
        ventas_id: ventaId,
        usuarios_id: usuariosId,
        monto,
        fecha: new Date(fecha),
        nota,
      },
    });

    const nuevoSaldo = saldo - monto;
    const nuevoEstado = nuevoSaldo <= 0 ? "pagada" : "parcial";

    await tx.ventas.update({
      where: { id: ventaId },
      data: { estado_pago: nuevoEstado },
    });

    await tx.movimientos_caja.create({
      data: {
        empresas_id: empresasId,
        usuarios_id: usuariosId,
        ventas_id: ventaId,
        tipo: "ingreso",
        categoria: "venta",
        monto,
        descripcion: `Abono venta #${ventaId}`,
        fecha: new Date(fecha),
      },
    });

    return pago;
  });
};

export { listar, resumen, registrarPago };
