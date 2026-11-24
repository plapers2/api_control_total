import prisma from "../../db/prisma.js";
import { fechaColombiaToUTC } from "../../utils/timezone.js";

const redondear = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const costoConocidoVenta = async (tx, ventaId) => {
  const venta = await tx.ventas.findUnique({
    where: { id: ventaId },
    include: { ventas_items: true },
  });
  if (!venta) return { venta: null, costo: 0, faltantes: 0, lineas: 0 };
  const lineas = venta.ventas_items.length;
  const faltantes = venta.ventas_items.filter((i) => i.costo_unitario == null).length;
  const costo = redondear(venta.ventas_items.reduce((s, i) => s + (i.costo_unitario == null ? 0 : Number(i.costo_unitario) * Number(i.cantidad)), 0));
  const historico = venta.ventas_items.some((i) => i.costo_unitario != null && i.estado_costo !== "verificado");
  const incompleto = venta.ventas_items.some((i) => i.estado_costo === "incompleto");
  const sinCostoVerificable = venta.ventas_items.length > 0 && venta.ventas_items.every((i) => i.costo_unitario == null && i.estado_costo === "sin_costo_verificable");
  return { venta, costo, faltantes, lineas, historico, incompleto, sinCostoVerificable };
};

const estadoCosto = ({ costo, faltantes, lineas, historico, incompleto, sinCostoVerificable }) => {
  if (incompleto) return "incompleto";
  if (faltantes === 0) return historico ? "historico_calculado" : "verificado";
  if (costo > 0 || incompleto) return "incompleto";
  return sinCostoVerificable || lineas > 0 ? "sin_costo_verificable" : "incompleto";
};

const recalcularFondo = async (tx, empresasId) => {
  const movimientos = await tx.fondo_reposicion_movimientos.findMany({
    where: { empresas_id: empresasId, anulado: false },
    orderBy: [{ fecha: "asc" }, { created_at: "asc" }, { id: "asc" }],
  });
  let saldo = 0;
  for (const mov of movimientos) {
    if (mov.tipo === "recuperacion") {
      saldo += Number(mov.monto ?? 0);
      continue;
    }
    const solicitado = Number(mov.monto_solicitado ?? 0);
    const aplicado = redondear(Math.min(Math.max(saldo, 0), solicitado));
    const externo = redondear(Math.max(0, solicitado - aplicado));
    saldo = redondear(saldo - aplicado);
    await tx.fondo_reposicion_movimientos.update({
      where: { id: mov.id },
      data: { monto: aplicado, monto_externo: externo },
    });
    if (mov.compra_insumos_id) {
      await tx.compras_insumos.update({
        where: { id: mov.compra_insumos_id },
        data: { monto_fondo: aplicado, monto_externo: externo },
      });
    }
  }
  return redondear(saldo);
};

const registrarRecuperacionVenta = async (tx, { empresasId, ventaId, montoCobrado, fecha, pagoVentaId = null, movimientoCajaId = null, createdAt = null, origen = "venta_inicial", recalcular = true }) => {
  const cobrado = redondear(montoCobrado);
  if (!(cobrado > 0)) return null;
  const datos = await costoConocidoVenta(tx, ventaId);
  if (!datos.venta || !(Number(datos.venta.total) > 0)) return null;
  const proporcion = Math.min(cobrado / Number(datos.venta.total), 1);
  const monto = redondear(datos.costo * proporcion);
  const data = {
    empresas_id: empresasId,
    tipo: "recuperacion",
    origen,
    monto,
    monto_cobrado: cobrado,
    estado_calculo: estadoCosto(datos),
    venta_id: ventaId,
    pago_venta_id: pagoVentaId,
    movimiento_caja_id: movimientoCajaId,
    fecha: fecha instanceof Date ? fecha : fechaColombiaToUTC(fecha),
    ...(createdAt ? { created_at: createdAt } : {}),
  };
  const mov = await tx.fondo_reposicion_movimientos.create({ data });
  if (recalcular) await recalcularFondo(tx, empresasId);
  return mov;
};

const recalcularRecuperacionesVenta = async (tx, ventaId) => {
  const datos = await costoConocidoVenta(tx, ventaId);
  if (!datos.venta) return;
  const eventos = await tx.fondo_reposicion_movimientos.findMany({
    where: { venta_id: ventaId, tipo: "recuperacion", anulado: false },
  });
  for (const evento of eventos) {
    const cobrado = Number(evento.monto_cobrado ?? 0);
    const proporcion = Number(datos.venta.total) > 0 ? Math.min(cobrado / Number(datos.venta.total), 1) : 0;
    await tx.fondo_reposicion_movimientos.update({
      where: { id: evento.id },
      data: { monto: redondear(datos.costo * proporcion), estado_calculo: estadoCosto(datos) },
    });
  }
  await recalcularFondo(tx, datos.venta.empresas_id);
};

const registrarUsoCompra = async (tx, { empresasId, compraId, movimientoCajaId, monto, fecha }) => {
  const data = {
    empresas_id: empresasId,
    tipo: "compra",
    origen: "compra_insumo",
    monto: 0,
    monto_solicitado: redondear(monto),
    monto_externo: redondear(monto),
    estado_calculo: "verificado",
    compra_insumos_id: compraId,
    movimiento_caja_id: movimientoCajaId,
    fecha: fecha instanceof Date ? fecha : fechaColombiaToUTC(fecha),
  };
  const existente = await tx.fondo_reposicion_movimientos.findFirst({ where: { compra_insumos_id: compraId } });
  if (existente) {
    await tx.fondo_reposicion_movimientos.update({ where: { id: existente.id }, data: { monto_solicitado: data.monto_solicitado, fecha: data.fecha, anulado: false } });
  } else {
    await tx.fondo_reposicion_movimientos.create({ data });
  }
  await recalcularFondo(tx, empresasId);
};

const actualizarUsoCompra = async (tx, { empresasId, compraId, monto, fecha }) => {
  const existente = await tx.fondo_reposicion_movimientos.findFirst({ where: { compra_insumos_id: compraId } });
  if (!existente) return registrarUsoCompra(tx, { empresasId, compraId, movimientoCajaId: null, monto, fecha });
  await tx.fondo_reposicion_movimientos.update({ where: { id: existente.id }, data: { monto_solicitado: redondear(monto), fecha: fecha instanceof Date ? fecha : fechaColombiaToUTC(fecha), anulado: false } });
  await recalcularFondo(tx, empresasId);
};

const anularUsoCompra = async (tx, empresasId, compraId, movimientoCajaId = null) => {
  const condiciones = [];
  if (compraId != null) condiciones.push({ compra_insumos_id: compraId });
  if (movimientoCajaId != null) condiciones.push({ movimiento_caja_id: movimientoCajaId });
  if (condiciones.length) {
    await tx.fondo_reposicion_movimientos.updateMany({
      where: { empresas_id: empresasId, tipo: "compra", anulado: false, OR: condiciones },
      data: { anulado: true },
    });
  }
  await recalcularFondo(tx, empresasId);
};

const resumenFondo = async (empresasId) => {
  const movimientos = await prisma.fondo_reposicion_movimientos.findMany({
    where: { empresas_id: empresasId, anulado: false },
    select: { tipo: true, monto: true, monto_externo: true, estado_calculo: true },
  });
  const recuperado = redondear(movimientos.filter((m) => m.tipo === "recuperacion").reduce((s, m) => s + Number(m.monto), 0));
  const compras = movimientos.filter((m) => m.tipo === "compra");
  const usado = redondear(compras.reduce((s, m) => s + Number(m.monto), 0));
  const financiadoFuera = redondear(compras.reduce((s, m) => s + Number(m.monto_externo ?? 0), 0));
  const config = await prisma.fondo_reposicion_config.findUnique({ where: { empresas_id: empresasId } });
  const eventosSinCosto = movimientos.filter((m) => m.estado_calculo === "sin_costo_verificable").length;
  const eventosIncompletos = movimientos.filter((m) => m.estado_calculo === "incompleto" || m.estado_calculo === "sin_costo_verificable").length;
  const estado = !config || config.estado_historico === "pendiente"
    ? "pendiente"
    : movimientos.some((m) => m.estado_calculo === "incompleto")
      ? "incompleto"
      : eventosSinCosto > 0
        ? "sin_costo_verificable"
        : config.estado_historico;
  return {
    recuperado,
    usado,
    financiado_fuera: financiadoFuera,
    balance: redondear(recuperado - usado),
    estado_historico: estado,
    eventos_incompletos: eventosIncompletos,
    ventas_incompletas: config?.ventas_incompletas ?? 0,
    compras_sin_detalle: config?.compras_sin_detalle ?? 0,
  };
};

const reconstruirHistorico = async (empresasId) => prisma.$transaction(async (tx) => {
  await tx.fondo_reposicion_movimientos.deleteMany({ where: { empresas_id: empresasId } });
  const ventas = await tx.ventas.findMany({
    where: { empresas_id: empresasId, anulada: false },
    include: {
      ventas_items: true,
      pagos_venta: { orderBy: [{ fecha: "asc" }, { created_at: "asc" }, { id: "asc" }] },
      movimientos_caja: { where: { anulado: false, tipo: "ingreso" }, orderBy: [{ fecha: "asc" }, { created_at: "asc" }, { id: "asc" }] },
    },
    orderBy: [{ fecha: "asc" }, { created_at: "asc" }, { id: "asc" }],
  });

  let ventasIncompletas = 0;
  let ventasSinCosto = 0;
  for (const venta of ventas) {
    for (const item of venta.ventas_items) {
      if (item.costo_unitario != null) continue;
      const lotes = await tx.lotes_produccion_items.findMany({
        where: {
          productos_id: item.productos_id,
          lotes_produccion: { empresas_id: empresasId, anulado: false, fecha: { lte: venta.fecha } },
        },
        select: { cantidad: true, costo_unitario: true },
      });
      const unidades = lotes.reduce((s, l) => s + Number(l.cantidad), 0);
      const valor = lotes.reduce((s, l) => s + Number(l.cantidad) * Number(l.costo_unitario), 0);
      if (unidades > 0 && valor > 0 && lotes.every((l) => Number(l.costo_unitario) > 0)) {
        await tx.ventas_items.update({ where: { id: item.id }, data: { costo_unitario: valor / unidades, estado_costo: "historico_calculado" } });
      } else {
        await tx.ventas_items.update({ where: { id: item.id }, data: { costo_unitario: null, estado_costo: lotes.length > 0 ? "incompleto" : "sin_costo_verificable" } });
      }
    }

    const costoDatos = await costoConocidoVenta(tx, venta.id);
    if (costoDatos.faltantes > 0) ventasIncompletas += 1;
    if (costoDatos.sinCostoVerificable) ventasSinCosto += 1;
    const pagos = venta.pagos_venta.length
      ? venta.pagos_venta.map((p) => ({ monto: Number(p.monto), fecha: p.fecha, created_at: p.created_at, pago_venta_id: p.id, origen: "abono" }))
      : venta.movimientos_caja.map((m) => ({ monto: Number(m.monto), fecha: m.fecha, created_at: m.created_at, movimiento_caja_id: m.id, origen: "venta_caja" }));

    for (const pago of pagos) {
      await registrarRecuperacionVenta(tx, {
        empresasId,
        ventaId: venta.id,
        montoCobrado: pago.monto,
        fecha: pago.fecha,
        pagoVentaId: pago.pago_venta_id ?? null,
        movimientoCajaId: pago.movimiento_caja_id ?? null,
        createdAt: pago.created_at,
        origen: pago.origen,
        recalcular: false,
      });
    }
  }

  const compras = await tx.movimientos_caja.findMany({
    where: { empresas_id: empresasId, anulado: false, tipo: "gasto", categoria: "insumo" },
    include: { compra_insumos: true },
    orderBy: [{ fecha: "asc" }, { created_at: "asc" }, { id: "asc" }],
  });
  let comprasSinDetalle = 0;
  for (const compra of compras) {
    const estructurada = !!compra.compra_insumos && !compra.compra_insumos.anulada;
    if (!estructurada) comprasSinDetalle += 1;
    await tx.fondo_reposicion_movimientos.create({
      data: {
        empresas_id: empresasId,
        tipo: "compra",
        origen: "compra_insumo_historica",
        monto: 0,
        monto_solicitado: Number(compra.monto),
        monto_externo: Number(compra.monto),
        estado_calculo: estructurada ? "historico_calculado" : "incompleto",
        compra_insumos_id: estructurada ? compra.compra_insumos.id : null,
        movimiento_caja_id: compra.id,
        fecha: compra.fecha,
        created_at: compra.created_at,
      },
    });
  }

  let estado = "historico_calculado";
  if (ventasIncompletas > 0 || comprasSinDetalle > 0) {
    estado = ventasSinCosto === ventas.length && ventas.length > 0 && comprasSinDetalle === 0 ? "sin_costo_verificable" : "incompleto";
  }
  await tx.fondo_reposicion_config.upsert({
    where: { empresas_id: empresasId },
    create: { empresas_id: empresasId, estado_historico: estado, ventas_incompletas: ventasIncompletas, compras_sin_detalle: comprasSinDetalle, fecha_reconstruccion: new Date() },
    update: { estado_historico: estado, ventas_incompletas: ventasIncompletas, compras_sin_detalle: comprasSinDetalle, fecha_reconstruccion: new Date() },
  });
  const balance = await recalcularFondo(tx, empresasId);
  return { balance, estado_historico: estado, ventas_incompletas: ventasIncompletas, compras_sin_detalle: comprasSinDetalle };
});

export {
  registrarRecuperacionVenta,
  recalcularRecuperacionesVenta,
  registrarUsoCompra,
  actualizarUsoCompra,
  anularUsoCompra,
  recalcularFondo,
  resumenFondo,
  reconstruirHistorico,
};
