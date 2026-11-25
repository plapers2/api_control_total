import { Prisma } from "../../generated/prisma/index.js";

const errorInventario = (mensaje, status = 409) => Object.assign(new Error(mensaje), { status });

const numero = (valor) => {
  if (valor == null) return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
};

const redondear = (valor, decimales = 4) => {
  const factor = 10 ** decimales;
  return Math.round((valor + Number.EPSILON) * factor) / factor;
};

const bloquearInsumo = async (tx, insumoId) => {
  await tx.$queryRaw`
    SELECT id
    FROM insumos
    WHERE id = ${insumoId}
    FOR UPDATE
  `;
};

const validarBase = (insumo) => {
  const tieneStock = insumo.stock_base != null;
  const tieneValor = insumo.valor_base != null;
  const tieneFecha = insumo.fecha_base != null;
  const tieneMovimiento = insumo.movimiento_base_id != null;

  const campos = [tieneStock, tieneFecha, tieneMovimiento];

  if (campos.some(Boolean) && !campos.every(Boolean)) {
    throw errorInventario("El inventario tiene una base histórica incompleta. Se requiere revisión.");
  }

  if (tieneStock && !Number.isFinite(Number(insumo.stock_base))) {
    throw errorInventario("La cantidad de la base histórica no es válida.");
  }

  if (tieneValor && !Number.isFinite(Number(insumo.valor_base))) {
    throw errorInventario("El valor de la base histórica no es válido.");
  }

  if (!tieneStock && insumo.valor_base != null) {
    throw errorInventario("El inventario tiene un valor base sin punto de corte histórico. Se requiere revisión.");
  }

  return tieneStock && tieneFecha && tieneMovimiento;
};

// Crea una base histórica una sola vez.
// Nunca deduce que un costo es verificable únicamente porque el stock sea cero.
export const asegurarBaseInsumo = async (tx, insumo) => {
  await bloquearInsumo(tx, insumo.id);

  const actual = await tx.insumos.findUnique({
    where: { id: insumo.id },
  });

  if (!actual) {
    throw errorInventario("El insumo no existe.", 404);
  }

  if (validarBase(actual)) {
    return actual;
  }

  const stockBase = numero(actual.stock_actual ?? 0);
  const precioBase = numero(actual.precio_unidad);

  if (stockBase == null || stockBase < 0) {
    throw errorInventario("El stock inicial del insumo no es válido.");
  }

  const costoConfiable = actual.estado_costo === "verificado" || actual.estado_costo === "historico_calculado";

  const costoVerificable = costoConfiable && precioBase != null && precioBase >= 0;

  const valorBase = costoVerificable ? redondear(stockBase * precioBase) : null;

  const ultimoMovimiento = await tx.movimientos_insumos.findFirst({
    where: { insumos_id: actual.id },
    orderBy: { id: "desc" },
    select: { id: true },
  });

  return tx.insumos.update({
    where: { id: actual.id },
    data: {
      stock_base: stockBase,
      valor_base: valorBase,
      fecha_base: new Date(),
      movimiento_base_id: ultimoMovimiento?.id ?? 0,
      estado_costo: costoVerificable ? (stockBase > 0 ? "historico_calculado" : "verificado") : "sin_costo_verificable",
    },
  });
};

// Reconstruye el inventario desde la base histórica y sus movimientos posteriores.
// Debe ejecutarse dentro de una transacción.
export const recalcularInsumo = async (tx, insumoId) => {
  await bloquearInsumo(tx, insumoId);

  const insumo = await tx.insumos.findUnique({
    where: { id: insumoId },
  });

  if (!insumo) return null;

  if (!validarBase(insumo)) {
    return insumo;
  }

  const stockBase = numero(insumo.stock_base);
  const movimientoBaseId = Number(insumo.movimiento_base_id);

  if (stockBase == null || stockBase < 0 || !Number.isInteger(movimientoBaseId) || movimientoBaseId < 0) {
    throw errorInventario("La base histórica del insumo no es válida.");
  }

  let cantidad = stockBase;
  let valor = numero(insumo.valor_base);

  if (insumo.valor_base != null && (valor == null || valor < 0)) {
    throw errorInventario("El valor de la base histórica no es válido.");
  }

  const movimientos = await tx.movimientos_insumos.findMany({
    where: {
      insumos_id: insumoId,
      anulado: false,
      id: { gt: movimientoBaseId },
    },
    orderBy: { id: "asc" },
  });

  for (const movimiento of movimientos) {
    const qty = numero(movimiento.cantidad);
    const costo = numero(movimiento.costo_total);

    if (qty == null || !Number.isFinite(qty)) {
      throw errorInventario(`El movimiento #${movimiento.id} tiene una cantidad inválida.`);
    }

    if (movimiento.tipo === "entrada") {
      if (qty <= 0) {
        throw errorInventario(`La entrada #${movimiento.id} tiene una cantidad inválida.`);
      }

      cantidad += qty;

      if (valor !== null) {
        if (costo == null || costo < 0) {
          valor = null;
        } else {
          valor += costo;
        }
      }
    } else if (movimiento.tipo === "salida") {
      if (qty <= 0) {
        throw errorInventario(`La salida #${movimiento.id} tiene una cantidad inválida.`);
      }

      cantidad -= qty;

      if (valor !== null) {
        if (costo == null || costo < 0) {
          valor = null;
        } else {
          valor -= costo;
        }
      }
    } else if (movimiento.tipo === "ajuste") {
      if (qty > 0) {
        // Un aumento por conteo físico no demuestra cuánto costó
        // la mercancía incorporada al inventario.
        cantidad += qty;
        valor = null;
      } else if (qty < 0) {
        cantidad += qty;

        if (valor !== null) {
          if (costo == null || costo < 0) {
            valor = null;
          } else {
            valor -= costo;
          }
        }
      }
    } else {
      throw errorInventario(`El movimiento #${movimiento.id} tiene un tipo desconocido.`);
    }

    if (cantidad < -0.0005) {
      throw errorInventario(`El movimiento #${movimiento.id} deja el inventario con stock negativo.`);
    }

    if (Math.abs(cantidad) < 0.0005) {
      cantidad = 0;
      if (valor !== null) valor = 0;
    }

    if (valor !== null && valor < -0.01) {
      throw errorInventario(`El movimiento #${movimiento.id} deja un valor de inventario negativo.`);
    }

    if (valor !== null && Math.abs(valor) < 0.01) {
      valor = 0;
    }
  }

  cantidad = redondear(cantidad, 3);

  const costoVerificable = valor !== null;
  const precioPromedio = costoVerificable ? (cantidad > 0 ? redondear(valor / cantidad, 4) : 0) : null;

  return tx.insumos.update({
    where: { id: insumoId },
    data: {
      stock_actual: new Prisma.Decimal(cantidad.toFixed(3)),
      precio_unidad: precioPromedio === null ? null : new Prisma.Decimal(precioPromedio.toFixed(4)),
      estado_costo: costoVerificable ? (Number(insumo.stock_base) > 0 ? "historico_calculado" : "verificado") : "sin_costo_verificable",
    },
  });
};
