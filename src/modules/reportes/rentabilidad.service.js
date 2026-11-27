import prisma from "../../db/prisma.js";
import { construirRangoFecha } from "../../utils/rangoFecha.js";

const SERVICIOS = ["energia", "agua", "gas"];
const CAMPO_USA = { energia: "usa_energia", agua: "usa_agua", gas: "usa_gas" };

const MILISEGUNDOS_DIA = 24 * 60 * 60 * 1000;
const DESFASE_COLOMBIA = 5 * 60 * 60 * 1000;

// Obtiene el día calendario colombiano de una fecha UTC.
const diaCalendarioColombia = (fecha) => {
  const local = new Date(fecha.getTime() - DESFASE_COLOMBIA);

  return Math.floor(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / MILISEGUNDOS_DIA);
};

// Los movimientos históricos sin periodo_servicio utilizan su fecha de Caja.
const obtenerPeriodoServicio = (movimiento) => {
  const periodo = String(movimiento.periodo_servicio ?? "");

  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) {
    return periodo;
  }

  return movimiento.fecha.toISOString().slice(0, 7);
};

// Calcula qué proporción de la factura mensual corresponde al rango consultado.
const proporcionPeriodoEnRango = (periodo, rangoFecha) => {
  if (!rangoFecha) {
    return { proporcion: 1, prorrateado: false };
  }

  const coincidencia = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(periodo);

  if (!coincidencia) {
    return { proporcion: 0, prorrateado: false };
  }

  const year = Number(coincidencia[1]);
  const month = Number(coincidencia[2]);

  const inicioMes = Date.UTC(year, month - 1, 1) / MILISEGUNDOS_DIA;

  const finMes = Date.UTC(year, month, 0) / MILISEGUNDOS_DIA;

  const inicioRango = diaCalendarioColombia(rangoFecha.gte);
  const finRango = diaCalendarioColombia(rangoFecha.lte);

  const inicioIncluido = Math.max(inicioMes, inicioRango);
  const finIncluido = Math.min(finMes, finRango);

  const diasIncluidos = Math.max(0, finIncluido - inicioIncluido + 1);

  const diasDelMes = finMes - inicioMes + 1;

  return {
    proporcion: diasIncluidos / diasDelMes,
    prorrateado: diasIncluidos > 0 && diasIncluidos < diasDelMes,
  };
};

// Por cada servicio (energia/agua/gas), calcula el costo indirecto por unidad
// en un rango de fecha dado:
//   gasto del periodo (categoria=servicio_publico, ese tipo_servicio)
//   ÷ unidades producidas en ese mismo periodo, SOLO de productos que usan
//     ese servicio (usa_energia/usa_agua/usa_gas = true).
// Ambos lados del cálculo usan aggregate (sin traer filas), igual que el
// resto de Caja/Ventas/Producción.

const calcularIndirectosPorServicio = async (empresasId, rangoFecha) => {
  const movimientos = await prisma.movimientos_caja.findMany({
    where: {
      empresas_id: empresasId,
      anulado: false,
      tipo: "gasto",
      categoria: "servicio_publico",
      tipo_servicio: { in: SERVICIOS },
    },
    select: {
      tipo_servicio: true,
      fecha: true,
      periodo_servicio: true,
      monto: true,
    },
  });

  const gastosPorServicio = Object.fromEntries(SERVICIOS.map((servicio) => [servicio, 0]));

  const serviciosProrrateados = new Set();

  for (const movimiento of movimientos) {
    const periodo = obtenerPeriodoServicio(movimiento);

    const { proporcion, prorrateado } = proporcionPeriodoEnRango(periodo, rangoFecha);

    if (!(proporcion > 0)) continue;

    const servicio = movimiento.tipo_servicio;

    gastosPorServicio[servicio] += Number(movimiento.monto) * proporcion;

    if (prorrateado) {
      serviciosProrrateados.add(servicio);
    }
  }

  const resultado = {};

  for (const servicio of SERVICIOS) {
    const gasto = gastosPorServicio[servicio];

    const unidadesAgg = await prisma.lotes_produccion_items.aggregate({
      where: {
        productos: {
          empresas_id: empresasId,
          [CAMPO_USA[servicio]]: true,
        },
        lotes_produccion: {
          empresas_id: empresasId,
          anulado: false,
          ...(rangoFecha && { fecha: rangoFecha }),
        },
      },
      _sum: { cantidad: true },
    });

    const unidades = Number(unidadesAgg._sum.cantidad ?? 0);

    resultado[servicio] = {
      gasto,
      unidades,
      costoUnitario: unidades > 0 ? gasto / unidades : 0,
      estimado: serviciosProrrateados.has(servicio),
    };
  }

  return resultado;
};

// Si un servicio no tuvo producción en el periodo consultado (ej. el mes
// apenas empieza, o aún no se registra la factura de ese mes), se usa el
// histórico completo (sin filtro de fecha) como respaldo, en vez de dejar el
// indirecto en $0 de forma engañosa. Se marca estimado:true para que el
// frontend lo indique ("costo estimado, aún no cerró el mes").

// Cuando faltan unidades producidas o no hay factura registrada,
// se utiliza el costo unitario histórico como estimación.
//
// Se conservan siempre el gasto y las unidades reales del periodo.
// Así no se presentan gastos históricos acumulados como si fueran
// gastos del mes consultado.
const calcularIndirectosConFallback = async (empresasId, rangoFecha) => {
  const actual = await calcularIndirectosPorServicio(empresasId, rangoFecha);

  // En el histórico completo no necesitamos fallback.
  if (!rangoFecha) return actual;

  const faltantes = SERVICIOS.filter((servicio) => actual[servicio].unidades === 0 || actual[servicio].gasto === 0);

  if (faltantes.length === 0) return actual;

  const historico = await calcularIndirectosPorServicio(empresasId, undefined);

  for (const servicio of faltantes) {
    const costoHistorico = historico[servicio].costoUnitario;

    if (historico[servicio].unidades > 0 && costoHistorico > 0) {
      actual[servicio] = {
        ...actual[servicio],
        costoUnitario: costoHistorico,
        estimado: true,
      };
    }
  }

  return actual;
};

// Costo directo promedio (insumos, según receta) por producto en el periodo:
// promedio ponderado del costo_unitario de todos los lotes de ese producto
// producidos dentro del rango. Si el producto no se produjo en el periodo
// (se vendió de stock ya existente), retorna null para ese id — el llamador
// decide si usa el histórico como respaldo.
const costoDirectoPorProducto = async (empresasId, productosIds, rangoFecha) => {
  if (productosIds.length === 0) return {};

  const items = await prisma.lotes_produccion_items.findMany({
    where: {
      productos_id: { in: productosIds },
      lotes_produccion: {
        empresas_id: empresasId,
        anulado: false,
        ...(rangoFecha && { fecha: rangoFecha }),
      },
    },
    select: { productos_id: true, cantidad: true, costo_unitario: true },
  });

  const acumulado = {};

  for (const it of items) {
    if (!acumulado[it.productos_id]) {
      acumulado[it.productos_id] = {
        costoTotal: 0,
        unidades: 0,
        incompleto: false,
      };
    }

    const producto = acumulado[it.productos_id];

    if (it.costo_unitario == null) {
      producto.incompleto = true;
      continue;
    }

    producto.costoTotal += Number(it.costo_unitario) * Number(it.cantidad);
    producto.unidades += Number(it.cantidad);
  }

  const resultado = {};

  for (const id of productosIds) {
    const producto = acumulado[id];

    resultado[id] = producto && !producto.incompleto && producto.unidades > 0 ? producto.costoTotal / producto.unidades : null;
  }

  return resultado;
};

// Costo de lo que se sacó para consumo propio (ventas con canal consumo_propio).
// No entra al ranking ni a la utilidad: se informa aparte.
const consumoPropioPeriodo = async (empresasId, rangoFecha, indirectos) => {
  const items = await prisma.ventas_items.findMany({
    where: {
      ventas: {
        empresas_id: empresasId,
        anulada: false,
        canal: "consumo_propio",
        ...(rangoFecha && { fecha: rangoFecha }),
      },
    },
    select: {
      productos_id: true,
      cantidad: true,
      costo_unitario: true,
      estado_costo: true,
      productos: {
        select: {
          usa_energia: true,
          usa_agua: true,
          usa_gas: true,
        },
      },
    },
  });

  if (items.length === 0) {
    return {
      unidades: 0,
      costoDirecto: 0,
      costoConVariable: 0,
      estimado: false,
      noVerificable: false,
    };
  }

  const ids = [...new Set(items.map((i) => i.productos_id))];
  const dPeriodo = await costoDirectoPorProducto(empresasId, ids, rangoFecha);
  const faltan = ids.filter((id) => dPeriodo[id] == null);
  const dHistorico = faltan.length ? await costoDirectoPorProducto(empresasId, faltan, undefined) : {};

  let unidades = 0;
  let costoDirecto = 0;
  let costoConVariable = 0;
  let costoDirectoCompleto = true;
  let costoConVariableCompleto = true;
  let estimado = false;

  for (const it of items) {
    const tieneSnapshot = it.costo_unitario != null;

    const directo = tieneSnapshot ? Number(it.costo_unitario) : (dPeriodo[it.productos_id] ?? dHistorico[it.productos_id] ?? null);

    if (!tieneSnapshot && directo != null) {
      estimado = true;
    }

    if (["incompleto", "sin_costo_verificable"].includes(it.estado_costo)) {
      estimado = true;
    }

    let indirecto = 0;
    let indirectosCompletos = true;

    const serviciosUsados = SERVICIOS.filter((servicio) => it.productos[`usa_${servicio}`]);

    for (const servicio of serviciosUsados) {
      const dato = indirectos[servicio];

      const verificable =
        dato &&
        Number.isFinite(Number(dato.costoUnitario)) &&
        (dato.estimado === true || (Number(dato.unidades) > 0 && Number(dato.gasto) > 0));

      if (!verificable) {
        indirectosCompletos = false;
        continue;
      }

      indirecto += Number(dato.costoUnitario);

      if (dato.estimado) {
        estimado = true;
      }
    }

    unidades += Number(it.cantidad);

    if (directo == null) {
      costoDirectoCompleto = false;
      costoConVariableCompleto = false;
    } else {
      costoDirecto += directo * Number(it.cantidad);
    }

    if (!indirectosCompletos) {
      costoConVariableCompleto = false;
    } else if (directo != null) {
      costoConVariable += (directo + indirecto) * Number(it.cantidad);
    }
  }

  return {
    unidades,
    costoDirecto: costoDirectoCompleto ? costoDirecto : null,
    costoConVariable: costoConVariableCompleto ? costoConVariable : null,
    estimado,
    noVerificable: !costoConVariableCompleto,
  };
};

// ── Rentabilidad por producto ───────────────────────────────────────────
// Cruza lo vendido en el periodo con el costo directo (insumos) + el costo
// indirecto prorrateado (servicios públicos), y arma el ranking con las
// 2 columnas: costo directo, y costo directo + variable.
const rentabilidad = async (empresasId, { periodo = "mes", desde, hasta } = {}) => {
  const rangoFecha = construirRangoFecha({ periodo, desde, hasta });

  const indirectos = await calcularIndirectosConFallback(empresasId, rangoFecha);
  const consumoPropio = await consumoPropioPeriodo(empresasId, rangoFecha, indirectos);

  const ventasItems = await prisma.ventas_items.findMany({
    where: {
      ventas: {
        empresas_id: empresasId,
        anulada: false,
        canal: { not: "consumo_propio" },
        ...(rangoFecha && { fecha: rangoFecha }),
      },
    },
    select: {
      productos_id: true,
      cantidad: true,
      subtotal: true,
      costo_unitario: true,
      estado_costo: true,
      productos: { select: { nombre: true, usa_energia: true, usa_agua: true, usa_gas: true } },
    },
  });

  if (ventasItems.length === 0) {
    return { indirectos, productos: [], consumoPropio };
  }

  // Acumular unidades vendidas e ingreso por producto
  const acumuladoVentas = {};
  for (const v of ventasItems) {
    if (!acumuladoVentas[v.productos_id]) {
      acumuladoVentas[v.productos_id] = {
        unidades: 0,
        ingreso: 0,
        costoSnapshot: 0,
        unidadesSnapshot: 0,
        unidadesSinSnapshot: 0,
        costoIncompleto: false,
        snapshotIncompleto: false,
        nombre: v.productos.nombre,
        usa_energia: v.productos.usa_energia,
        usa_agua: v.productos.usa_agua,
        usa_gas: v.productos.usa_gas,
      };
    }
    acumuladoVentas[v.productos_id].unidades += v.cantidad;
    acumuladoVentas[v.productos_id].ingreso += Number(v.subtotal);
    if (v.costo_unitario != null) {
      acumuladoVentas[v.productos_id].costoSnapshot += Number(v.costo_unitario) * v.cantidad;
      acumuladoVentas[v.productos_id].unidadesSnapshot += v.cantidad;
      if (["incompleto", "sin_costo_verificable"].includes(v.estado_costo)) {
        acumuladoVentas[v.productos_id].snapshotIncompleto = true;
      }
    } else {
      acumuladoVentas[v.productos_id].unidadesSinSnapshot += v.cantidad;
    }
    if (["incompleto", "sin_costo_verificable"].includes(v.estado_costo)) acumuladoVentas[v.productos_id].costoIncompleto = true;
  }

  const productosIds = Object.keys(acumuladoVentas).map(Number);

  // Costo directo: primero se intenta con lo producido EN el periodo; si un
  // producto no se produjo ese periodo (se vendió de stock), se usa el
  // histórico completo como respaldo.
  const directosPeriodo = await costoDirectoPorProducto(empresasId, productosIds, rangoFecha);
  const faltanDirecto = productosIds.filter((id) => directosPeriodo[id] == null);
  const directosHistorico = faltanDirecto.length > 0 ? await costoDirectoPorProducto(empresasId, faltanDirecto, undefined) : {};

  const productos = productosIds
    .map((id) => {
      const venta = acumuladoVentas[id];

      const costoFallback = directosPeriodo[id] ?? directosHistorico[id] ?? null;
      const costoDirectoCompleto = !venta.snapshotIncompleto && (venta.unidadesSinSnapshot === 0 || costoFallback != null);
      const costoDirectoTotal = costoDirectoCompleto
        ? venta.costoSnapshot + (costoFallback ?? 0) * venta.unidadesSinSnapshot
        : null;
      const costoDirectoUnit = costoDirectoCompleto && venta.unidades > 0
        ? costoDirectoTotal / venta.unidades
        : null;
      const costoDirectoEstimado = costoDirectoCompleto && (venta.unidadesSinSnapshot > 0 || venta.costoIncompleto);

      const serviciosUsados = SERVICIOS.filter((s) => venta[`usa_${s}`]);

      const indirectosCompletos = serviciosUsados.every((servicio) => {
        const dato = indirectos[servicio];

        return (
          dato &&
          dato.costoUnitario != null &&
          Number.isFinite(Number(dato.costoUnitario)) &&
          (dato.estimado === true || (Number(dato.unidades) > 0 && Number(dato.gasto) > 0))
        );
      });

      const indirectoEstimado = serviciosUsados.some((s) => indirectos[s]?.estimado === true);
      const indirectoUnit = indirectosCompletos
        ? serviciosUsados.reduce((sum, s) => sum + Number(indirectos[s].costoUnitario), 0)
        : null;

      const costoConVariableCompleto = costoDirectoCompleto && indirectosCompletos;
      const costoConVariableUnit = costoConVariableCompleto
        ? costoDirectoUnit + indirectoUnit
        : null;
      const costoConVariableTotal = costoConVariableCompleto
        ? costoConVariableUnit * venta.unidades
        : null;

      const utilidadDirecta = costoDirectoCompleto
        ? venta.ingreso - costoDirectoTotal
        : null;
      const utilidadConVariable = costoConVariableCompleto
        ? venta.ingreso - costoConVariableTotal
        : null;

      return {
        productos_id: id,
        nombre: venta.nombre,
        unidadesVendidas: venta.unidades,
        ingreso: venta.ingreso,
        costoDirectoUnitario: costoDirectoUnit,
        costoDirectoTotal,
        costoDirectoEstimado,
        costoDirectoNoVerificable: !costoDirectoCompleto,
        costoConVariableUnitario: costoConVariableUnit,
        costoConVariableTotal,
        costoConVariableEstimado: costoConVariableCompleto && (costoDirectoEstimado || indirectoEstimado),
        costoConVariableNoVerificable: !costoConVariableCompleto,
        indirectoEstimado,
        utilidadDirecta,
        utilidadConVariable,
        margenDirecto: costoDirectoCompleto
          ? venta.ingreso > 0 ? utilidadDirecta / venta.ingreso : 0
          : null,
        margenConVariable: costoConVariableCompleto
          ? venta.ingreso > 0 ? utilidadConVariable / venta.ingreso : 0
          : null,
      };
    })
    .sort((a, b) => {
      const aVerificable = a.utilidadConVariable != null;
      const bVerificable = b.utilidadConVariable != null;

      if (aVerificable !== bVerificable) {
        return aVerificable ? -1 : 1;
      }

      if (!aVerificable) {
        return a.nombre.localeCompare(b.nombre);
      }

      return b.utilidadConVariable - a.utilidadConVariable;
    });

  return { indirectos, productos, consumoPropio };
};

export { rentabilidad };
