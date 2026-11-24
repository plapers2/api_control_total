const errorInventario = (mensaje) => Object.assign(new Error(mensaje), { status: 409 });

// Bloquea la fila del insumo.
// Debe ejecutarse dentro de una transacción.
const bloquearInsumo = async (tx, insumoId) => {
  await tx.$queryRaw`
    SELECT id
    FROM insumos
    WHERE id = ${insumoId}
    FOR UPDATE
  `;
};

// Mantiene una base histórica inmutable.
// Solo inicializa insumos que todavía no tienen una base.
export const asegurarBaseInsumo = async (tx, insumo) => {
  await bloquearInsumo(tx, insumo.id);

  // Volvemos a consultar después del bloqueo.
  const actual = await tx.insumos.findUnique({
    where: { id: insumo.id },
  });

  if (!actual) {
    throw Object.assign(new Error("El insumo no existe."), {
      status: 404,
    });
  }

  const tieneStockBase = actual.stock_base != null;
  const tieneFechaBase = actual.fecha_base != null;
  const tieneMovimientoBase = actual.movimiento_base_id != null;

  // La base ya está inicializada.
  if (tieneStockBase && tieneFechaBase && tieneMovimientoBase) {
    return actual;
  }

  // No permitimos bases parciales.
  if (tieneStockBase || tieneFechaBase || tieneMovimientoBase) {
    throw errorInventario("El inventario tiene una base histórica incompleta o sin punto de corte. Se requiere revisión.");
  }

  const stockBase = Number(actual.stock_actual ?? 0);
  const precioBase = Number(actual.precio_unidad ?? 0);

  if (!Number.isFinite(stockBase) || stockBase < 0 || !Number.isFinite(precioBase) || precioBase < 0) {
    throw errorInventario("El stock o el precio del insumo tienen valores inválidos.");
  }

  // Solo confiamos en costos con un estado explícitamente verificable.
  // No inferimos verificabilidad por el simple hecho de tener stock cero.
  const costoConfiable = actual.estado_costo === "verificado" || actual.estado_costo === "historico_calculado";

  const valorBase = costoConfiable ? stockBase * precioBase : null;

  // Capturamos el último movimiento existente.
  // Los movimientos posteriores tendrán un ID mayor.
  const ultimoMovimiento = await tx.movimientos_insumos.findFirst({
    where: {
      insumos_id: actual.id,
    },
    orderBy: {
      id: "desc",
    },
    select: {
      id: true,
    },
  });

  const movimientoBaseId = ultimoMovimiento?.id ?? 0;

  return tx.insumos.update({
    where: { id: actual.id },
    data: {
      stock_base: stockBase,
      valor_base: valorBase,
      fecha_base: new Date(),
      movimiento_base_id: movimientoBaseId,
      estado_costo: valorBase === null ? "sin_costo_verificable" : stockBase > 0 ? "historico_calculado" : "verificado",
    },
  });
};

// Reconstruye el inventario desde su base histórica
// y los movimientos posteriores al punto de corte.
export const recalcularInsumo = async (tx, insumoId) => {
  // Bloqueamos antes de leer la base y los movimientos.
  await bloquearInsumo(tx, insumoId);

  const insumo = await tx.insumos.findUnique({
    where: { id: insumoId },
  });

  if (!insumo) return null;

  const tieneStockBase = insumo.stock_base != null;
  const tieneFechaBase = insumo.fecha_base != null;
  const tieneMovimientoBase = insumo.movimiento_base_id != null;

  // Un insumo sin base todavía no puede reconstruirse.
  if (!tieneStockBase && !tieneFechaBase && !tieneMovimientoBase) {
    return insumo;
  }

  // Una base parcial no es segura.
  if (!tieneStockBase || !tieneFechaBase || !tieneMovimientoBase) {
    throw errorInventario("No se puede reconstruir el inventario: la base histórica está incompleta.");
  }

  const stockBase = Number(insumo.stock_base);
  const movimientoBaseId = Number(insumo.movimiento_base_id);

  if (!Number.isFinite(stockBase) || stockBase < 0 || !Number.isInteger(movimientoBaseId) || movimientoBaseId < 0) {
    throw errorInventario("La base histórica del insumo contiene valores inválidos.");
  }

  const movimientos = await tx.movimientos_insumos.findMany({
    where: {
      insumos_id: insumoId,
      anulado: false,
      id: {
        gt: movimientoBaseId,
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  let cantidad = stockBase;

  // Si la base no tiene costo verificable, el valor permanece desconocido.
  let valor = insumo.valor_base == null ? null : Number(insumo.valor_base);

  if (valor !== null && (!Number.isFinite(valor) || valor < 0)) {
    throw errorInventario("El valor de la base histórica es inválido.");
  }

  for (const mov of movimientos) {
    const qty = Number(mov.cantidad);

    const costo = mov.costo_total == null ? null : Number(mov.costo_total);

    if (!Number.isFinite(qty)) {
      throw errorInventario(`El movimiento ${mov.id} tiene una cantidad inválida.`);
    }

    if (mov.tipo === "entrada") {
      if (qty <= 0) {
        throw errorInventario(`La entrada ${mov.id} tiene una cantidad inválida.`);
      }

      cantidad += qty;

      // Una entrada sin costo verificable invalida el valor global.
      if (valor !== null) {
        if (costo === null || !Number.isFinite(costo) || costo < 0) {
          valor = null;
        } else {
          valor += costo;
        }
      }
    } else if (mov.tipo === "salida") {
      if (qty <= 0) {
        throw errorInventario(`La salida ${mov.id} tiene una cantidad inválida.`);
      }

      cantidad -= qty;

      if (valor !== null) {
        if (costo === null || !Number.isFinite(costo) || costo < 0) {
          valor = null;
        } else {
          valor -= costo;
        }
      }
    } else if (mov.tipo === "ajuste") {
      if (qty === 0) continue;

      if (qty > 0) {
        // No conocemos el costo de las unidades encontradas.
        // El costo global seguirá desconocido hasta una conciliación.
        cantidad += qty;
        valor = null;
      } else {
        // El ajuste negativo utiliza el costo registrado al realizarlo.
        const cantidadRetirada = Math.abs(qty);

        if (cantidadRetirada > cantidad + 0.0005) {
          throw errorInventario(`El ajuste dejaría negativo el inventario de "${insumo.nombre}".`);
        }

        cantidad -= cantidadRetirada;

        if (valor !== null) {
          if (costo === null || !Number.isFinite(costo) || costo < 0) {
            valor = null;
          } else {
            valor -= costo;
          }
        }
      }
    } else {
      throw errorInventario(`El movimiento ${mov.id} tiene un tipo desconocido.`);
    }
  }

  if (cantidad < -0.0005) {
    throw errorInventario(`El inventario de "${insumo.nombre}" quedaría negativo al recalcular.`);
  }

  if (Math.abs(cantidad) < 0.0005) {
    cantidad = 0;

    if (valor !== null) {
      valor = 0;
    }
  }

  if (valor !== null && valor < -0.01) {
    throw errorInventario(`El valor del inventario de "${insumo.nombre}" quedaría negativo al recalcular.`);
  }

  if (valor !== null && Math.abs(valor) < 0.01) {
    valor = 0;
  }

  const promedio = valor === null ? null : cantidad > 0 ? valor / cantidad : 0;

  // El estado se deriva de la verificabilidad reconstruida.
  // No se recupera automáticamente si hubo movimientos desconocidos.
  const estadoCosto = valor === null ? "sin_costo_verificable" : stockBase > 0 ? "historico_calculado" : "verificado";

  return tx.insumos.update({
    where: { id: insumoId },
    data: {
      stock_actual: cantidad,
      precio_unidad: promedio,
      estado_costo: estadoCosto,
    },
  });
};
