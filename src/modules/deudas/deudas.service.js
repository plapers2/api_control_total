import prisma from "../../db/prisma.js";
import { fechaColombiaToUTC } from "../../utils/timezone.js";
import { noEncontrado } from "../../utils/errors.js";
import { moverSaldo } from "../clientes/saldo.service.js";

const badRequest = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });

// Una venta anulada nunca es deuda, aunque su estado_pago siga en pendiente/parcial.
const filtroDeudas = (empresasId) => ({
  empresas_id: empresasId,
  anulada: false,
  estado_pago: { in: ["pendiente", "parcial"] },
});

const calcularSaldo = (venta) => {
  const pagado = venta.pagos_venta.reduce((s, p) => s + Number(p.monto), 0);
  return Number(venta.total) - pagado;
};

const listar = async (empresasId, { page = 1, limit = 10 } = {}) => {
  const skip = (Number(page) - 1) * Number(limit);

  const where = filtroDeudas(empresasId);

  const [rows, count] = await Promise.all([
    prisma.ventas.findMany({
      where,
      orderBy: [{ fecha: "desc" }, { created_at: "desc" }, { id: "desc" }],
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
    where: filtroDeudas(empresasId),
    include: { pagos_venta: true },
  });

  const totalPorCobrar = ventas.reduce((s, v) => s + calcularSaldo(v), 0);

  return { totalPorCobrar, cantidadVentas: ventas.length };
};

const registrarPago = async (ventaId, empresasId, usuariosId, { monto, nota, fecha }) => {
  if (!Number.isFinite(monto) || monto <= 0) throw badRequest("El monto del abono debe ser mayor a 0.");

  return prisma.$transaction(async (tx) => {
    const venta = await tx.ventas.findFirst({
      where: { id: ventaId, empresas_id: empresasId },
      include: { pagos_venta: true },
    });
    if (!venta) throw noEncontrado("Venta no encontrada.");
    if (venta.anulada) throw badRequest("Esta venta está anulada y no admite abonos.");
    if (venta.estado_pago === "pagada") throw badRequest("Esta venta ya está pagada por completo.");

    const pagadoActual = venta.pagos_venta.reduce((s, p) => s + Number(p.monto), 0);
    const saldo = Number(venta.total) - pagadoActual;

    if (monto > saldo) throw badRequest(`El abono no puede ser mayor al saldo pendiente (${saldo}).`);

    const pago = await tx.pagos_venta.create({
      data: {
        ventas_id: ventaId,
        usuarios_id: usuariosId,
        monto,
        fecha: fechaColombiaToUTC(fecha),
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
        fecha: fechaColombiaToUTC(fecha),
      },
    });

    return pago;
  });
};

const centavos = (n) => Math.round(Number(n) * 100);

// Saldo en centavos (evita errores de decimales al sumar y restar)
const saldoCentavos = (venta) => centavos(venta.total) - venta.pagos_venta.reduce((s, p) => s + centavos(p.monto), 0);

// Cliente 0 = ventas a crédito sin cliente asignado
const filtroCliente = (clientesId) => ({ clientes_id: clientesId > 0 ? clientesId : null });

// Una fila por cliente con lo que debe en total
const listarPorCliente = async (empresasId) => {
  const ventas = await prisma.ventas.findMany({
    where: filtroDeudas(empresasId),
    orderBy: [{ fecha: "asc" }, { created_at: "asc" }, { id: "asc" }],
    include: { clientes: true, pagos_venta: true },
  });

  const mapa = new Map();
  for (const v of ventas) {
    const saldo = saldoCentavos(v);
    if (saldo <= 0) continue;
    const clave = v.clientes_id ?? 0;
    if (!mapa.has(clave)) {
      mapa.set(clave, {
        clientes_id: v.clientes_id,
        nombre: v.clientes?.nombre ?? "Sin cliente",
        telefono: v.clientes?.telefono ?? null,
        totalDeuda: 0,
        cantidadVentas: 0,
        masAntigua: v.fecha,
      });
    }
    const c = mapa.get(clave);
    c.totalDeuda += saldo / 100;
    c.cantidadVentas += 1;
  }

  return [...mapa.values()].sort((a, b) => b.totalDeuda - a.totalDeuda);
};

// Compras pendientes de un cliente, de la más vieja a la más reciente
const ventasPendientesCliente = (tx, empresasId, clientesId) =>
  tx.ventas.findMany({
    where: { ...filtroDeudas(empresasId), ...filtroCliente(clientesId) },
    orderBy: [{ fecha: "asc" }, { created_at: "asc" }, { id: "asc" }],
    include: { pagos_venta: true, ventas_items: { include: { productos: true } } },
  });

const detalleCliente = async (clientesId, empresasId) => {
  let cliente = { id: null, nombre: "Sin cliente", telefono: null };
  if (clientesId > 0) {
    const c = await prisma.clientes.findFirst({ where: { id: clientesId, empresas_id: empresasId } });
    if (!c) throw noEncontrado("Cliente no encontrado.");
    cliente = { id: c.id, nombre: c.nombre, telefono: c.telefono };
  }

  const ventas = (await ventasPendientesCliente(prisma, empresasId, clientesId))
    .map((v) => {
      const saldo = saldoCentavos(v);
      return {
        id: v.id,
        fecha: v.fecha,
        total: Number(v.total),
        pagado: (centavos(v.total) - saldo) / 100,
        saldo: saldo / 100,
        estado_pago: v.estado_pago,
        ventas_items: v.ventas_items.map((i) => ({
          id: i.id,
          cantidad: i.cantidad,
          subtotal: Number(i.subtotal),
          productos: { nombre: i.productos?.nombre },
        })),
      };
    })
    .filter((v) => v.saldo > 0);

  const totalDeuda = ventas.reduce((s, v) => s + centavos(v.saldo), 0) / 100;
  return { cliente, totalDeuda, ventas };
};

// Abono general: se reparte desde la deuda más vieja hasta la más reciente
const registrarPagoCliente = async (clientesId, empresasId, usuariosId, guardar_excedente, { monto, nota, fecha }) => {
  if (!Number.isFinite(monto) || monto <= 0) throw badRequest("El monto del abono debe ser mayor a 0.");

  return prisma.$transaction(async (tx) => {
    const pendientes = (await ventasPendientesCliente(tx, empresasId, clientesId))
      .map((v) => ({ venta: v, saldo: saldoCentavos(v) }))
      .filter((x) => x.saldo > 0);

    if (pendientes.length === 0) throw noEncontrado("Este cliente no tiene deudas pendientes.");

    const deudaTotal = pendientes.reduce((s, x) => s + x.saldo, 0);
    let restante = centavos(monto);
    if (restante > deudaTotal) {
      if (!guardar_excedente) throw badRequest(`El abono (${monto}) es mayor a la deuda total (${deudaTotal / 100}).`);
      if (!(clientesId > 0)) throw badRequest("Sin cliente asignado no se puede dejar saldo a favor.");
    }

    const aplicados = [];
    for (const { venta, saldo } of pendientes) {
      if (restante <= 0) break;
      const aplicar = Math.min(restante, saldo);
      const montoVenta = aplicar / 100;
      const saldaTodo = aplicar === saldo;

      await tx.pagos_venta.create({
        data: {
          ventas_id: venta.id,
          usuarios_id: usuariosId,
          monto: montoVenta,
          fecha: fechaColombiaToUTC(fecha),
          nota: nota || "Abono general",
        },
      });
      await tx.ventas.update({
        where: { id: venta.id },
        data: { estado_pago: saldaTodo ? "pagada" : "parcial" },
      });
      await tx.movimientos_caja.create({
        data: {
          empresas_id: empresasId,
          usuarios_id: usuariosId,
          ventas_id: venta.id,
          tipo: "ingreso",
          categoria: "venta",
          monto: montoVenta,
          descripcion: `Abono venta #${venta.id}`,
          fecha: fechaColombiaToUTC(fecha),
        },
      });

      aplicados.push({
        ventas_id: venta.id,
        monto: montoVenta,
        saldoRestante: (saldo - aplicar) / 100,
        estado_pago: saldaTodo ? "pagada" : "parcial",
      });
      restante -= aplicar;
    }

    // Lo que sobra de pagar toda la deuda queda como saldo a favor del cliente
    let excedente = 0;
    if (restante > 0) {
      excedente = restante / 100;
      await moverSaldo(tx, {
        empresasId,
        clientesId,
        usuariosId,
        tipo: "deposito",
        monto: excedente,
        nota: "Excedente de abono general",
        fecha: fechaColombiaToUTC(fecha),
      });
      await tx.movimientos_caja.create({
        data: {
          empresas_id: empresasId,
          usuarios_id: usuariosId,
          clientes_id: clientesId,
          tipo: "ingreso",
          categoria: "otro",
          monto: excedente,
          descripcion: "Saldo a favor (excedente de abono)",
          fecha: fechaColombiaToUTC(fecha),
        },
      });
    }

    return { monto, aplicados, excedente };
  });
};

export { listar, resumen, registrarPago, listarPorCliente, detalleCliente, registrarPagoCliente };
