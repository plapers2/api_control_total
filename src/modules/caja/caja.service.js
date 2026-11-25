import prisma from "../../db/prisma.js";
import { fechaColombiaToUTC } from "../../utils/timezone.js";
import { construirRangoFecha } from "../../utils/rangoFecha.js";
import { validarInsumos } from "../../utils/pertenencia.js";
import { noEncontrado } from "../../utils/errors.js";
import { asegurarBaseInsumo, recalcularInsumo } from "../../utils/inventarioInsumos.js";
import {
  bloquearEmpresaServiciosPublicos,
  validarPeriodoControlado,
  validarReciboUnico,
} from "../servicios-publicos/servicios-publicos.service.js";
import {
  registrarUsoCompra,
  actualizarUsoCompra,
  anularUsoCompra,
  resumenFondo,
  recalcularFondo,
} from "../fondo-reposicion/fondo.service.js";

// Los movimientos que nacen de una venta o de un abono (ventas_id) se corrigen
// desde Ventas o Deudas. Editarlos o anularlos aquí descuadra la caja frente a
// pagos_venta y a las deudas.
const rechazarSiEsDeVenta = (mov) => {
  if (mov.ventas_id) {
    throw Object.assign(new Error("Este movimiento viene de la venta #" + mov.ventas_id + ". Para corregirlo, edita o anula la venta."), {
      status: 400,
    });
  }
  if (mov.clientes_id) {
    throw Object.assign(new Error("Este movimiento es saldo a favor de un cliente. Corrígelo desde Clientes."), { status: 400 });
  }
};

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
      orderBy: [{ fecha: "desc" }, { created_at: "desc" }, { id: "desc" }],
      skip,
      take: Number(limit),
      include: {
        usuarios: { select: { id: true, nombre: true } },
        ventas: true,
        compra_insumos: { include: { items: { include: { insumos: true } } } },
      },
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

const resumenDisponible = async (empresasId) => {
  const [caja, saldos, fondo] = await Promise.all([
    balanceActual(empresasId),

    prisma.clientes.aggregate({
      where: { empresas_id: empresasId },
      _sum: { saldo_favor: true },
    }),

    resumenFondo(empresasId),
  ]);

  const redondear = (valor) => Math.round((Number(valor) + Number.EPSILON) * 100) / 100;

  const balanceCaja = redondear(caja.balance);
  const saldoClientes = redondear(saldos._sum.saldo_favor ?? 0);

  // Una reserva negativa nunca puede aumentar el dinero disponible.
  const reservaFondo = redondear(Math.max(Number(fondo.balance), 0));

  const disponible = redondear(balanceCaja - saldoClientes - reservaFondo);

  const historicoConfiable = fondo.estado_historico === "historico_calculado";

  return {
    disponible,
    balance_caja: balanceCaja,
    saldos_favor_clientes: saldoClientes,
    reserva_fondo: reservaFondo,
    balance_fondo: redondear(fondo.balance),
    estado_historico_fondo: fondo.estado_historico,
    historico_confiable: historicoConfiable,
    requiere_revision: !historicoConfiable,
  };
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

// Las compras de insumos son movimientos de Caja con detalle obligatorio.
// Cada línea conserva cantidad y costo individual y alimenta el promedio
// ponderado del inventario.
const normalizarCompra = (insumos, monto) => {
  if (!Array.isArray(insumos) || insumos.length === 0) {
    throw Object.assign(new Error("Una compra de insumos debe incluir al menos un insumo y su cantidad y costo."), { status: 400 });
  }
  const ids = insumos.map((i) => Number(i.insumos_id));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0))
    throw Object.assign(new Error("Selecciona un insumo válido para cada línea de la compra."), { status: 400 });
  if (new Set(ids).size !== ids.length)
    throw Object.assign(new Error("No repitas el mismo insumo en una compra; consolida su cantidad."), { status: 400 });
  const items = insumos.map((i) => {
    const cantidadEntrada = Number(i.cantidad);
    const cantidad = Math.round(cantidadEntrada * 1000) / 1000;
    const costoEntrada = Number(i.costo_unitario);
    const costoUnitario = Math.round(costoEntrada * 10000) / 10000;
    if (!Number.isFinite(cantidadEntrada) || cantidad <= 0 || !Number.isFinite(costoEntrada) || costoUnitario <= 0) {
      throw Object.assign(new Error("Cada insumo debe tener cantidad y costo unitario mayores a 0."), { status: 400 });
    }
    return {
      insumos_id: Number(i.insumos_id),
      cantidad,
      costo_unitario: costoUnitario,
      costo_total: Math.round(cantidad * costoUnitario * 100) / 100,
    };
  });
  const total = Math.round(items.reduce((s, i) => s + i.costo_total, 0) * 100) / 100;
  if (Math.abs(total - Number(monto)) > 0.01) {
    throw Object.assign(
      new Error(`La suma de los insumos (${total.toFixed(2)}) debe coincidir con el movimiento de Caja (${Number(monto).toFixed(2)}).`),
      { status: 400 },
    );
  }
  return items;
};

const bloquearInsumos = async (tx, ids) => {
  const ordenados = [...new Set(ids.map(Number))].sort((a, b) => a - b);

  // Siempre bloqueamos en el mismo orden para reducir interbloqueos.
  for (const id of ordenados) {
    await tx.$queryRaw`
      SELECT id
      FROM insumos
      WHERE id = ${id}
      FOR UPDATE
    `;
  }

  return ordenados;
};

const validarCompraEditable = async (tx, items) => {
  for (const item of items) {
    const movimientoId = item.movimiento_insumos?.id;

    if (!movimientoId || item.movimiento_insumos.anulado) {
      throw Object.assign(new Error("La compra tiene un movimiento de inventario incompleto. Se requiere revisión antes de modificarla."), {
        status: 409,
      });
    }

    const insumo = await tx.insumos.findUnique({
      where: { id: item.insumos_id },
      select: {
        nombre: true,
        movimiento_base_id: true,
      },
    });

    if (!insumo) {
      throw Object.assign(new Error("No se encontró uno de los insumos asociados a la compra."), { status: 409 });
    }

    // No se puede modificar un movimiento que ya quedó incluido
    // dentro de la base histórica del inventario.
    if (insumo.movimiento_base_id != null && movimientoId <= insumo.movimiento_base_id) {
      throw Object.assign(
        new Error(
          `No se puede modificar esta compra porque la entrada del insumo "${insumo.nombre}" ya forma parte de la base histórica del inventario.`,
        ),
        { status: 409 },
      );
    }

    // No basta con comprobar si hubo producción:
    // cualquier movimiento posterior puede depender de este costo.
    const posterior = await tx.movimientos_insumos.findFirst({
      where: {
        insumos_id: item.insumos_id,
        id: { gt: movimientoId },
        anulado: false,
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });

    if (posterior) {
      throw Object.assign(
        new Error(
          `No se puede modificar la compra del insumo "${insumo.nombre}" porque tiene movimientos posteriores de inventario. Para conservar el historial de costos, primero debes corregir esos movimientos posteriores.`,
        ),
        { status: 409 },
      );
    }
  }
};

const crearDetalleCompra = async (tx, mov, usuariosId, items, fecha) => {
  const ids = await bloquearInsumos(
    tx,
    items.map((item) => item.insumos_id),
  );

  const insumos = await tx.insumos.findMany({
    where: {
      id: { in: ids },
      empresas_id: mov.empresas_id,
      activo: true,
    },
  });

  if (insumos.length !== ids.length) {
    throw Object.assign(new Error("Uno o más insumos no existen, están inactivos o no pertenecen a esta empresa."), { status: 400 });
  }

  const insumosPorId = new Map(insumos.map((i) => [i.id, i]));

  const compra = await tx.compras_insumos.create({
    data: {
      empresas_id: mov.empresas_id,
      movimientos_caja_id: mov.id,
      fecha: fechaColombiaToUTC(fecha),
      monto_total: mov.monto,
    },
  });

  for (const item of items) {
    const insumo = insumosPorId.get(item.insumos_id);

    await asegurarBaseInsumo(tx, insumo);

    const detalle = await tx.compras_insumos_items.create({
      data: {
        compra_id: compra.id,
        insumos_id: item.insumos_id,
        cantidad: item.cantidad,
        costo_unitario: item.costo_unitario,
        costo_total: item.costo_total,
      },
    });

    await tx.movimientos_insumos.create({
      data: {
        insumos_id: item.insumos_id,
        tipo: "entrada",
        cantidad: item.cantidad,
        costo_total: item.costo_total,
        compra_item_id: detalle.id,
        nota: `Compra registrada en caja #${mov.id}`,
        usuarios_id: usuariosId,
      },
    });

    await recalcularInsumo(tx, item.insumos_id);
  }

  await registrarUsoCompra(tx, {
    empresasId: mov.empresas_id,
    compraId: compra.id,
    movimientoCajaId: mov.id,
    monto: Number(mov.monto),
    fecha,
  });

  return compra;
};

const recuperarCompraHistorica = async (id, empresasId) => {
  return prisma.$transaction(async (tx) => {
    const conflicto = (mensaje) => Object.assign(new Error(mensaje), { status: 409 });

    const redondearMoneda = (valor) => Math.round((Number(valor) + Number.EPSILON) * 100) / 100;

    const redondearPrecision = (valor, decimales = 4) => {
      const factor = 10 ** decimales;
      return Math.round((Number(valor) + Number.EPSILON) * factor) / factor;
    };

    // Comprobar que la operación original de Caja existe y sigue activa.
    const mov = await tx.movimientos_caja.findFirst({
      where: {
        id,
        empresas_id: empresasId,
        tipo: "gasto",
        categoria: "insumo",
        anulado: false,
      },
      include: {
        compra_insumos: true,
      },
    });

    if (!mov) {
      throw noEncontrado("Compra histórica de Caja no encontrada.");
    }

    // Debe existir exactamente un evento activo del fondo para esta compra.
    const eventos = await tx.fondo_reposicion_movimientos.findMany({
      where: {
        empresas_id: empresasId,
        movimiento_caja_id: id,
        tipo: "compra",
        anulado: false,
      },
    });

    if (eventos.length !== 1) {
      throw conflicto("No existe un único evento activo del fondo asociado a esta compra.");
    }

    const evento = eventos[0];

    // Permitir repetir la operación sin generar duplicados.
    if (mov.compra_insumos) {
      if (evento.compra_insumos_id === mov.compra_insumos.id && evento.estado_calculo === "historico_calculado") {
        return {
          compra_id: mov.compra_insumos.id,
          movimiento_caja_id: id,
          ya_recuperada: true,
        };
      }

      throw conflicto("La compra ya tiene una estructura registrada, pero necesita revisión de sus relaciones.");
    }

    if (evento.estado_calculo !== "incompleto" || evento.compra_insumos_id != null) {
      throw conflicto("El evento del fondo no está en condiciones de recuperarse automáticamente.");
    }

    // Los movimientos originales deben haberse generado junto con Caja.
    const instanteCaja = new Date(mov.created_at).getTime();

    const desde = new Date(instanteCaja - 2000);
    const hasta = new Date(instanteCaja + 2000);

    const notaEsperada = `Compra registrada en caja #${id}`;

    const entradas = await tx.movimientos_insumos.findMany({
      where: {
        tipo: "entrada",
        anulado: false,
        lotes_produccion_id: null,
        nota: notaEsperada,
        created_at: {
          gte: desde,
          lte: hasta,
        },
      },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
    });

    if (!entradas.length) {
      throw conflicto("No se encontraron entradas de inventario que permitan verificar esta compra.");
    }

    // No reutilizar movimientos que ya pertenecen a otra compra.
    if (entradas.some((entrada) => entrada.compra_item_id != null)) {
      throw conflicto("Una o más entradas de inventario ya están vinculadas a otra compra.");
    }

    let totalCompra = 0;

    for (const entrada of entradas) {
      const cantidad = Number(entrada.cantidad);
      const costoTotalOriginal = Number(entrada.costo_total);

      if (
        !Number.isFinite(cantidad) ||
        cantidad <= 0 ||
        entrada.costo_total == null ||
        !Number.isFinite(costoTotalOriginal) ||
        costoTotalOriginal <= 0
      ) {
        throw conflicto(`La entrada de inventario #${entrada.id} no tiene cantidad y costo verificables.`);
      }

      // La tabla de detalles conserva el costo total con dos decimales.
      const costoRedondeado = redondearMoneda(costoTotalOriginal);

      if (Math.abs(costoTotalOriginal - costoRedondeado) > 0.00001) {
        throw conflicto(`El costo de la entrada #${entrada.id} no puede trasladarse exactamente al detalle de compra.`);
      }

      totalCompra += costoRedondeado;
    }

    totalCompra = redondearMoneda(totalCompra);

    if (Math.round(totalCompra * 100) !== Math.round(Number(mov.monto) * 100)) {
      throw conflicto(
        `Las entradas de inventario suman $${totalCompra}, pero el movimiento de Caja registra $${Number(mov.monto)}. No coinciden.`,
      );
    }

    // Verificar que todos los insumos pertenecen a la empresa.
    const insumosIds = [...new Set(entradas.map((e) => e.insumos_id))];

    const insumos = await tx.insumos.findMany({
      where: {
        id: { in: insumosIds },
        empresas_id: empresasId,
      },
      select: { id: true },
    });

    if (insumos.length !== insumosIds.length) {
      throw conflicto("Una o más entradas corresponden a insumos que no pertenecen a esta empresa.");
    }

    // Crear únicamente la estructura contable de la compra.
    const compra = await tx.compras_insumos.create({
      data: {
        empresas_id: empresasId,
        movimientos_caja_id: mov.id,
        fecha: mov.fecha,
        monto_total: mov.monto,
      },
    });

    let detallesVinculados = 0;

    for (const entrada of entradas) {
      const cantidad = Number(entrada.cantidad);
      const costoTotal = redondearMoneda(entrada.costo_total);
      const costoUnitario = redondearPrecision(Number(entrada.costo_total) / cantidad, 4);

      const detalle = await tx.compras_insumos_items.create({
        data: {
          compra_id: compra.id,
          insumos_id: entrada.insumos_id,
          cantidad,
          costo_unitario: costoUnitario,
          costo_total: costoTotal,
        },
      });

      // Vincular la entrada existente. No crear otra entrada ni modificar stock.
      await tx.movimientos_insumos.update({
        where: { id: entrada.id },
        data: {
          compra_item_id: detalle.id,
        },
      });

      detallesVinculados += 1;
    }

    // Asociar la estructura recuperada con el evento histórico existente.
    await tx.fondo_reposicion_movimientos.update({
      where: { id: evento.id },
      data: {
        compra_insumos_id: compra.id,
        estado_calculo: "historico_calculado",
      },
    });

    // Redistribuir el fondo según la cronología original.
    // Esto actualizará monto_fondo y monto_externo de la compra.
    const balance = await recalcularFondo(tx, empresasId);

    // Actualizar el contador de compras incompletas sin reconstruir el historial.
    const comprasSinDetalle = await tx.fondo_reposicion_movimientos.count({
      where: {
        empresas_id: empresasId,
        tipo: "compra",
        anulado: false,
        estado_calculo: "incompleto",
      },
    });

    const eventosSinCosto = await tx.fondo_reposicion_movimientos.count({
      where: {
        empresas_id: empresasId,
        anulado: false,
        estado_calculo: "sin_costo_verificable",
      },
    });

    const config = await tx.fondo_reposicion_config.findUnique({
      where: { empresas_id: empresasId },
    });

    const ventasIncompletas = Number(config?.ventas_incompletas ?? 0);

    const estadoHistorico =
      ventasIncompletas > 0 || comprasSinDetalle > 0 ? "incompleto" : eventosSinCosto > 0 ? "sin_costo_verificable" : "historico_calculado";

    await tx.fondo_reposicion_config.upsert({
      where: { empresas_id: empresasId },
      create: {
        empresas_id: empresasId,
        estado_historico: estadoHistorico,
        ventas_incompletas: ventasIncompletas,
        compras_sin_detalle: comprasSinDetalle,
      },
      update: {
        estado_historico: estadoHistorico,
        compras_sin_detalle: comprasSinDetalle,
      },
    });

    return {
      compra_id: compra.id,
      movimiento_caja_id: mov.id,
      detalles_vinculados: detallesVinculados,
      entradas_inventario_reutilizadas: detallesVinculados,
      balance_fondo: balance,
      compras_sin_detalle: comprasSinDetalle,
      estado_historico: estadoHistorico,
      ya_recuperada: false,
    };
  });
};

const registrar = async (
  empresasId,
  usuariosId,
  { tipo, categoria, monto, descripcion, fecha, insumos, tipo_servicio, periodo_servicio },
) => {
  const tipoServicioFinal = categoria === "servicio_publico" ? (tipo_servicio ?? null) : null;

  let periodoServicioFinal = null;

  if (categoria === "servicio_publico") {
    if (tipo !== "gasto") {
      throw Object.assign(new Error("Un servicio público debe registrarse como gasto."), { status: 400 });
    }

    await validarPeriodoControlado(empresasId, tipoServicioFinal, periodo_servicio);

    periodoServicioFinal = periodo_servicio;
  }

  if (categoria === "insumo" && tipo !== "gasto") {
    throw Object.assign(new Error("Las compras de insumos deben registrarse como gastos."), { status: 400 });
  }

  const itemsCompra = categoria === "insumo" ? normalizarCompra(insumos, monto) : null;

  if (itemsCompra) {
    await validarInsumos(
      prisma,
      empresasId,
      itemsCompra.map((i) => i.insumos_id),
    );
  }

  if (categoria !== "insumo" && insumos?.length) {
    throw Object.assign(new Error("Solo los gastos de categoría insumo pueden incluir productos de inventario."), { status: 400 });
  }

  return prisma.$transaction(async (tx) => {
    if (categoria === "servicio_publico") {
      await bloquearEmpresaServiciosPublicos(tx, empresasId);

      await validarReciboUnico(tx, {
        empresasId,
        servicio: tipoServicioFinal,
        periodo: periodoServicioFinal,
      });
    }

    const mov = await tx.movimientos_caja.create({
      data: {
        empresas_id: empresasId,
        usuarios_id: usuariosId,
        tipo,
        categoria,
        tipo_servicio: tipoServicioFinal,
        periodo_servicio: periodoServicioFinal,
        monto,
        descripcion,
        fecha: fechaColombiaToUTC(fecha),
      },
    });

    if (itemsCompra) {
      await crearDetalleCompra(tx, mov, usuariosId, itemsCompra, fecha);
    }

    return mov;
  });
};

const actualizar = async (id, empresasId, { tipo, categoria, monto, descripcion, fecha, insumos, tipo_servicio, periodo_servicio }) => {
  const tipoServicioFinal = categoria === "servicio_publico" ? (tipo_servicio ?? null) : null;
  return prisma.$transaction(async (tx) => {
    const mov = await tx.movimientos_caja.findFirst({
      where: { id, empresas_id: empresasId, anulado: false },
      include: { compra_insumos: { include: { items: { include: { movimiento_insumos: true } } } } },
    });
    if (!mov) throw noEncontrado("Movimiento no encontrado.");
    rechazarSiEsDeVenta(mov);

    // Cualquier modificación de un recibo debe coordinarse con los registros
    // nuevos para evitar duplicados concurrentes.
    const requiereBloqueoServicios = mov.categoria === "servicio_publico" || categoria === "servicio_publico";

    if (requiereBloqueoServicios) {
      await bloquearEmpresaServiciosPublicos(tx, empresasId);
    }

    let periodoServicioFinal = null;

    if (categoria === "servicio_publico") {
      if (tipo !== "gasto") {
        throw Object.assign(new Error("Un servicio público debe registrarse como gasto."), { status: 400 });
      }

      // Mantiene el periodo anterior si no se envía uno nuevo.
      // Para registros históricos sin periodo, se utiliza el mes de su fecha.
      periodoServicioFinal = periodo_servicio ?? mov.periodo_servicio ?? mov.fecha.toISOString().slice(0, 7);

      await validarPeriodoControlado(empresasId, tipoServicioFinal, periodoServicioFinal);

      await validarReciboUnico(tx, {
        empresasId,
        servicio: tipoServicioFinal,
        periodo: periodoServicioFinal,
        excluirMovimientoId: id,
      });
    }

    if (mov.compra_insumos) {
      if (tipo !== "gasto" || categoria !== "insumo") {
        throw Object.assign(new Error("Una compra vinculada a inventario debe conservar el tipo gasto y la categoría insumo."), {
          status: 400,
        });
      }

      const items = normalizarCompra(insumos, monto);
      const oldItems = mov.compra_insumos.items;

      const idsAnteriores = oldItems.map((i) => i.insumos_id).sort((a, b) => a - b);
      const idsNuevos = items.map((i) => i.insumos_id).sort((a, b) => a - b);

      if (idsAnteriores.length !== idsNuevos.length || idsAnteriores.some((id, index) => id !== idsNuevos[index])) {
        throw Object.assign(
          new Error(
            "Para conservar el historial del inventario, una compra existente no puede cambiar sus insumos. Anula la compra y registra una nueva.",
          ),
          { status: 400 },
        );
      }

      const ids = await bloquearInsumos(tx, idsAnteriores);

      await validarInsumos(tx, empresasId, ids);
      await validarCompraEditable(tx, oldItems);

      const itemsPorId = new Map(items.map((item) => [item.insumos_id, item]));

      // Actualizamos los registros existentes.
      // No creamos movimientos nuevos ni cambiamos sus IDs.
      for (const old of oldItems) {
        const item = itemsPorId.get(old.insumos_id);

        await tx.compras_insumos_items.update({
          where: { id: old.id },
          data: {
            cantidad: item.cantidad,
            costo_unitario: item.costo_unitario,
            costo_total: item.costo_total,
          },
        });

        await tx.movimientos_insumos.update({
          where: { id: old.movimiento_insumos.id },
          data: {
            cantidad: item.cantidad,
            costo_total: item.costo_total,
            nota: `Compra registrada en caja #${id} (editada)`,
          },
        });
      }

      await tx.compras_insumos.update({
        where: { id: mov.compra_insumos.id },
        data: {
          fecha: fechaColombiaToUTC(fecha),
          monto_total: monto,
        },
      });

      const actualizado = await tx.movimientos_caja.update({
        where: { id },
        data: {
          tipo,
          categoria,
          tipo_servicio: null,
          periodo_servicio: null,
          monto,
          descripcion,
          fecha: fechaColombiaToUTC(fecha),
        },
      });

      for (const insumoId of ids) {
        await recalcularInsumo(tx, insumoId);
      }

      await actualizarUsoCompra(tx, {
        empresasId,
        compraId: mov.compra_insumos.id,
        monto: Number(monto),
        fecha,
      });

      return actualizado;
    }

    if (categoria === "insumo")
      throw Object.assign(
        new Error(
          "No se puede convertir un movimiento existente en compra de insumos. Registra una compra nueva con su detalle de inventario.",
        ),
        { status: 400 },
      );
    if (mov.tipo === "gasto" && mov.categoria === "insumo") {
      // Si era una compra histórica sin detalle, al cambiar su categoría deja de consumir el fondo.
      await anularUsoCompra(tx, empresasId, null, mov.id);
    }
    return tx.movimientos_caja.update({
      where: { id },
      data: {
        tipo,
        categoria,
        tipo_servicio: tipoServicioFinal,
        periodo_servicio: periodoServicioFinal,
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
      include: { compra_insumos: { include: { items: { include: { movimiento_insumos: true } } } } },
    });
    if (!mov) throw noEncontrado("Movimiento no encontrado o ya anulado.");
    rechazarSiEsDeVenta(mov);

    if (mov.compra_insumos) {
      const items = mov.compra_insumos.items;

      const ids = await bloquearInsumos(
        tx,
        items.map((item) => item.insumos_id),
      );

      await validarCompraEditable(tx, items);

      for (const item of items) {
        await tx.movimientos_insumos.update({
          where: { id: item.movimiento_insumos.id },
          data: { anulado: true },
        });
      }

      await tx.compras_insumos.update({
        where: { id: mov.compra_insumos.id },
        data: { anulada: true },
      });

      await anularUsoCompra(tx, empresasId, mov.compra_insumos.id, mov.id);

      for (const insumoId of ids) {
        await recalcularInsumo(tx, insumoId);
      }
    }

    return tx.movimientos_caja.update({ where: { id }, data: { anulado: true, motivo_anulacion: motivo } });
  });
};

export { listar, resumen, registrar, actualizar, anular, balanceActual, resumenDisponible, recuperarCompraHistorica };
