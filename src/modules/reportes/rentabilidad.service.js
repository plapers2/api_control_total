import prisma from "../../db/prisma.js";
import { construirRangoFecha } from "../../utils/rangoFecha.js";

const SERVICIOS = ["energia", "agua", "gas"];
const CAMPO_USA = { energia: "usa_energia", agua: "usa_agua", gas: "usa_gas" };

// Por cada servicio (energia/agua/gas), calcula el costo indirecto por unidad
// en un rango de fecha dado:
//   gasto del periodo (categoria=servicio_publico, ese tipo_servicio)
//   ÷ unidades producidas en ese mismo periodo, SOLO de productos que usan
//     ese servicio (usa_energia/usa_agua/usa_gas = true).
// Ambos lados del cálculo usan aggregate (sin traer filas), igual que el
// resto de Caja/Ventas/Producción.
const calcularIndirectosPorServicio = async (empresasId, rangoFecha) => {
  const resultado = {};

  for (const servicio of SERVICIOS) {
    const gastoAgg = await prisma.movimientos_caja.aggregate({
      where: {
        empresas_id: empresasId,
        anulado: false,
        tipo: "gasto",
        categoria: "servicio_publico",
        tipo_servicio: servicio,
        ...(rangoFecha && { fecha: rangoFecha }),
      },
      _sum: { monto: true },
    });
    const gasto = Number(gastoAgg._sum.monto ?? 0);

    const unidadesAgg = await prisma.lotes_produccion_items.aggregate({
      where: {
        productos: { empresas_id: empresasId, [CAMPO_USA[servicio]]: true },
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
      estimado: false,
    };
  }

  return resultado;
};

// Si un servicio no tuvo producción en el periodo consultado (ej. el mes
// apenas empieza, o aún no se registra la factura de ese mes), se usa el
// histórico completo (sin filtro de fecha) como respaldo, en vez de dejar el
// indirecto en $0 de forma engañosa. Se marca estimado:true para que el
// frontend lo indique ("costo estimado, aún no cerró el mes").
const calcularIndirectosConFallback = async (empresasId, rangoFecha) => {
  const actual = await calcularIndirectosPorServicio(empresasId, rangoFecha);
  const faltantes = SERVICIOS.filter((s) => actual[s].unidades === 0);
  if (faltantes.length === 0 || !rangoFecha) return actual;

  const historico = await calcularIndirectosPorServicio(empresasId, undefined);
  for (const s of faltantes) {
    if (historico[s].unidades > 0) {
      actual[s] = { ...historico[s], estimado: true };
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
    if (!acumulado[it.productos_id]) acumulado[it.productos_id] = { costoTotal: 0, unidades: 0 };
    acumulado[it.productos_id].costoTotal += Number(it.costo_unitario) * it.cantidad;
    acumulado[it.productos_id].unidades += it.cantidad;
  }

  const resultado = {};
  for (const id of productosIds) {
    const a = acumulado[id];
    resultado[id] = a && a.unidades > 0 ? a.costoTotal / a.unidades : null;
  }
  return resultado;
};

// ── Rentabilidad por producto ───────────────────────────────────────────
// Cruza lo vendido en el periodo con el costo directo (insumos) + el costo
// indirecto prorrateado (servicios públicos), y arma el ranking con las
// 2 columnas: costo directo, y costo directo + variable.
const rentabilidad = async (empresasId, { periodo = "mes", desde, hasta } = {}) => {
  const rangoFecha = construirRangoFecha({ periodo, desde, hasta });

  const indirectos = await calcularIndirectosConFallback(empresasId, rangoFecha);

  const ventasItems = await prisma.ventas_items.findMany({
    where: {
      ventas: {
        empresas_id: empresasId,
        anulada: false,
        ...(rangoFecha && { fecha: rangoFecha }),
      },
    },
    select: {
      productos_id: true,
      cantidad: true,
      subtotal: true,
      productos: { select: { nombre: true, usa_energia: true, usa_agua: true, usa_gas: true } },
    },
  });

  if (ventasItems.length === 0) {
    return { indirectos, productos: [] };
  }

  // Acumular unidades vendidas e ingreso por producto
  const acumuladoVentas = {};
  for (const v of ventasItems) {
    if (!acumuladoVentas[v.productos_id]) {
      acumuladoVentas[v.productos_id] = {
        unidades: 0,
        ingreso: 0,
        nombre: v.productos.nombre,
        usa_energia: v.productos.usa_energia,
        usa_agua: v.productos.usa_agua,
        usa_gas: v.productos.usa_gas,
      };
    }
    acumuladoVentas[v.productos_id].unidades += v.cantidad;
    acumuladoVentas[v.productos_id].ingreso += Number(v.subtotal);
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

      const costoDirectoUnit = directosPeriodo[id] ?? directosHistorico[id] ?? 0;
      const costoDirectoEstimado = directosPeriodo[id] == null;

      const serviciosUsados = SERVICIOS.filter((s) => venta[`usa_${s}`]);
      const indirectoUnit = serviciosUsados.reduce((sum, s) => sum + indirectos[s].costoUnitario, 0);
      const indirectoEstimado = serviciosUsados.some((s) => indirectos[s].estimado);

      const costoDirectoTotal = costoDirectoUnit * venta.unidades;
      const costoConVariableUnit = costoDirectoUnit + indirectoUnit;
      const costoConVariableTotal = costoConVariableUnit * venta.unidades;

      return {
        productos_id: id,
        nombre: venta.nombre,
        unidadesVendidas: venta.unidades,
        ingreso: venta.ingreso,
        costoDirectoUnitario: costoDirectoUnit,
        costoDirectoTotal,
        costoDirectoEstimado,
        costoConVariableUnitario: costoConVariableUnit,
        costoConVariableTotal,
        indirectoEstimado,
        utilidadDirecta: venta.ingreso - costoDirectoTotal,
        utilidadConVariable: venta.ingreso - costoConVariableTotal,
        margenDirecto: venta.ingreso > 0 ? (venta.ingreso - costoDirectoTotal) / venta.ingreso : 0,
        margenConVariable: venta.ingreso > 0 ? (venta.ingreso - costoConVariableTotal) / venta.ingreso : 0,
      };
    })
    .sort((a, b) => b.utilidadConVariable - a.utilidadConVariable);

  return { indirectos, productos };
};

export { rentabilidad };
