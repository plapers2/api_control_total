import prisma from "../../db/prisma.js";
import { noEncontrado } from "../../utils/errors.js";
import { asegurarBaseInsumo, recalcularInsumo } from "../../utils/inventarioInsumos.js";

const errorInventario = (mensaje, status = 400) => Object.assign(new Error(mensaje), { status });

const numeroValido = (valor) =>
  (typeof valor === "number" || typeof valor === "string") &&
  String(valor).trim() !== "" &&
  Number.isFinite(Number(valor));

const redondear = (valor, decimales = 4) => {
  const factor = 10 ** decimales;
  return Math.round((valor + Number.EPSILON) * factor) / factor;
};

const listar = async (empresasId) =>
  prisma.insumos.findMany({
    where: { empresas_id: empresasId, activo: true },
    orderBy: { nombre: "asc" },
  });

const obtener = async (id, empresasId) =>
  prisma.insumos.findFirst({
    where: { id, empresas_id: empresasId, activo: true },
    include: {
      recetas: {
        include: { productos: true },
      },
    },
  });

const crear = async (empresasId, data) => {
  const stock = Number(data.stock_actual ?? 0);
  const precio = Number(data.precio_unidad ?? 0);

  const estadoCosto =
    Number.isFinite(stock) &&
    stock >= 0 &&
    Number.isFinite(precio) &&
    precio >= 0 &&
    (stock === 0 || precio > 0)
      ? "verificado"
      : "sin_costo_verificable";

  return prisma.insumos.create({
    data: {
      ...data,
      empresas_id: empresasId,
      estado_costo: estadoCosto,
    },
  });
};

const actualizar = async (id, empresasId, data) =>
  prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM insumos
      WHERE id = ${id} AND empresas_id = ${empresasId}
      FOR UPDATE
    `;

    const actual = await tx.insumos.findFirst({
      where: { id, empresas_id: empresasId },
    });

    if (!actual) throw noEncontrado("Insumo no encontrado.");

    const tieneStockBase = actual.stock_base != null;
    const tieneFechaBase = actual.fecha_base != null;
    const tieneMovimientoBase = actual.movimiento_base_id != null;
    const tieneBase = tieneStockBase || tieneFechaBase || tieneMovimientoBase;

    if (tieneBase && !(tieneStockBase && tieneFechaBase && tieneMovimientoBase)) {
      throw errorInventario("El inventario tiene una base histórica incompleta. Se requiere revisión.", 409);
    }

    const cambiaStock =
      data.stock_actual != null && Number(data.stock_actual) !== Number(actual.stock_actual ?? 0);
    const cambiaCosto =
      data.precio_unidad != null && Number(data.precio_unidad) !== Number(actual.precio_unidad ?? 0);

    if (tieneBase && (cambiaStock || cambiaCosto)) {
      throw errorInventario(
        "El stock y el costo promedio se actualizan desde compras, producción y ajustes de inventario. Para establecer un nuevo costo debes realizar una conciliación.",
      );
    }

    const datos = { ...data };

    if (!tieneBase && (cambiaStock || cambiaCosto)) {
      const movimientoAnterior = await tx.movimientos_insumos.findFirst({
        where: { insumos_id: id },
        select: { id: true },
      });

      if (movimientoAnterior) {
        throw errorInventario(
          "Este insumo ya tiene movimientos históricos. No puedes modificar manualmente su stock o costo inicial.",
          409,
        );
      }

      const stock = Number(datos.stock_actual ?? actual.stock_actual ?? 0);
      const precio = Number(datos.precio_unidad ?? actual.precio_unidad ?? 0);

      datos.estado_costo =
        Number.isFinite(stock) &&
        stock >= 0 &&
        Number.isFinite(precio) &&
        precio >= 0 &&
        (stock === 0 || precio > 0)
          ? "verificado"
          : "sin_costo_verificable";
    }

    return tx.insumos.update({
      where: { id },
      data: datos,
    });
  });

const eliminar = async (id, empresasId) => {
  const { count } = await prisma.insumos.updateMany({
    where: { id, empresas_id: empresasId },
    data: { activo: false },
  });
  if (count === 0) throw noEncontrado("Insumo no encontrado.");
};

const ajustarInventario = async (id, empresasId, usuarioId, stockReal, motivo) => {
  if (
    !numeroValido(stockReal) ||
    Number(stockReal) < 0 ||
    Math.abs(Number(stockReal) * 1000 - Math.round(Number(stockReal) * 1000)) > 0.000001
  ) {
    throw errorInventario("El stock contado debe ser un número válido, no negativo y máximo con 3 decimales.");
  }

  if (typeof motivo !== "string" || !motivo.trim() || motivo.trim().length > 180) {
    throw errorInventario("El motivo del ajuste es obligatorio y debe tener máximo 180 caracteres.");
  }

  const stockContado = redondear(Number(stockReal), 3);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM insumos
      WHERE id = ${id} AND empresas_id = ${empresasId}
      FOR UPDATE
    `;

    const encontrado = await tx.insumos.findFirst({
      where: { id, empresas_id: empresasId, activo: true },
    });

    if (!encontrado) throw noEncontrado("Insumo no encontrado.");

    const insumo = await asegurarBaseInsumo(tx, encontrado);
    const stockActual = Number(insumo.stock_actual ?? 0);
    const diferencia = redondear(stockContado - stockActual, 3);

    if (Math.abs(diferencia) < 0.0005) {
      return {
        mensaje: "El inventario ya coincide con el conteo físico.",
        sinCambios: true,
        insumo,
      };
    }

    let costoTotal = null;

    if (diferencia < 0) {
      const costoPromedio = Number(insumo.precio_unidad);
      const costoVerificable =
        insumo.estado_costo === "verificado" || insumo.estado_costo === "historico_calculado";

      if (costoVerificable && Number.isFinite(costoPromedio) && costoPromedio >= 0) {
        costoTotal = redondear(Math.abs(diferencia) * costoPromedio, 4);
      }
    }

    await tx.movimientos_insumos.create({
      data: {
        insumos_id: id,
        tipo: "ajuste",
        cantidad: diferencia,
        costo_total: costoTotal,
        anulado: false,
        usuarios_id: usuarioId,
        nota: motivo.trim(),
      },
    });

    const actualizado = await recalcularInsumo(tx, id);

    return {
      mensaje: "Ajuste de inventario registrado correctamente.",
      sinCambios: false,
      diferencia,
      insumo: actualizado,
    };
  });
};

/**
 * Establece una nueva base verificable del inventario.
 * Los movimientos existentes no se editan ni se anulan: el último ID queda
 * registrado como corte y solo los movimientos posteriores se aplicarán
 * sobre esta nueva base al reconstruir el inventario.
 */
const conciliarInventario = async (id, empresasId, usuarioId, stockReal, valorTotal, motivo) => {
  if (
    !numeroValido(stockReal) ||
    Number(stockReal) < 0 ||
    Math.abs(Number(stockReal) * 1000 - Math.round(Number(stockReal) * 1000)) > 0.000001
  ) {
    throw errorInventario("stock_real debe ser un número no negativo con máximo 3 decimales.");
  }

  if (!numeroValido(valorTotal) || Number(valorTotal) < 0) {
    throw errorInventario("valor_total debe ser un número válido igual o mayor a cero.");
  }

  if (typeof motivo !== "string" || !motivo.trim() || motivo.trim().length > 180) {
    throw errorInventario("El motivo de la conciliación es obligatorio y debe tener máximo 180 caracteres.");
  }

  const stockConciliado = redondear(Number(stockReal), 3);
  const valorConciliado = redondear(Number(valorTotal), 4);

  if (stockConciliado === 0 && valorConciliado !== 0) {
    throw errorInventario("No puedes asignar valor a un inventario cuya cantidad es cero.");
  }

  if (stockConciliado > 0 && valorConciliado <= 0) {
    throw errorInventario("Para verificar un inventario con existencias, el valor total debe ser mayor que cero.");
  }

  if (stockConciliado > 9999999.999) {
    throw errorInventario("La cantidad supera el máximo permitido para el stock del insumo.");
  }

  if (valorConciliado > 9999999999.9999) {
    throw errorInventario("El valor total supera el máximo permitido para la base del inventario.");
  }

  const precioUnitario = stockConciliado > 0 ? redondear(valorConciliado / stockConciliado, 4) : 0;

  if (precioUnitario > 999999.9999) {
    throw errorInventario("El costo unitario calculado supera el máximo permitido.");
  }

  return prisma.$transaction(async (tx) => {
    // El bloqueo serializa la conciliación con compras, producción y ajustes
    // que utilizan asegurarBaseInsumo antes de registrar movimientos.
    await tx.$queryRaw`
      SELECT id FROM insumos
      WHERE id = ${id} AND empresas_id = ${empresasId}
      FOR UPDATE
    `;

    const insumo = await tx.insumos.findFirst({
      where: { id, empresas_id: empresasId, activo: true },
    });

    if (!insumo) throw noEncontrado("Insumo no encontrado.");

    const ultimoMovimiento = await tx.movimientos_insumos.findFirst({
      where: { insumos_id: id },
      orderBy: { id: "desc" },
      select: { id: true },
    });

    const movimientoCorteId = ultimoMovimiento?.id ?? 0;
    const fechaBase = new Date();

    const conciliacion = await tx.conciliaciones_insumos.create({
      data: {
        empresas_id: empresasId,
        insumos_id: id,
        usuarios_id: usuarioId,
        stock_anterior: insumo.stock_actual,
        precio_unidad_anterior: insumo.precio_unidad,
        estado_costo_anterior: insumo.estado_costo,
        stock_base_anterior: insumo.stock_base,
        valor_base_anterior: insumo.valor_base,
        fecha_base_anterior: insumo.fecha_base,
        movimiento_base_anterior_id: insumo.movimiento_base_id,
        stock_conciliado: stockConciliado,
        valor_conciliado: valorConciliado,
        precio_unidad_conciliado: precioUnitario,
        movimiento_corte_id: movimientoCorteId,
        motivo: motivo.trim(),
        created_at: fechaBase,
      },
      include: {
        usuarios: { select: { id: true, nombre: true } },
      },
    });

    const actualizado = await tx.insumos.update({
      where: { id },
      data: {
        stock_actual: stockConciliado,
        precio_unidad: precioUnitario,
        stock_base: stockConciliado,
        valor_base: valorConciliado,
        fecha_base: fechaBase,
        movimiento_base_id: movimientoCorteId,
        estado_costo: "verificado",
      },
    });

    return {
      mensaje: "Conciliación de inventario registrada correctamente.",
      conciliacion,
      insumo: actualizado,
    };
  });
};

const listarConciliaciones = async (id, empresasId) => {
  const insumo = await prisma.insumos.findFirst({
    where: { id, empresas_id: empresasId, activo: true },
    select: { id: true },
  });

  if (!insumo) throw noEncontrado("Insumo no encontrado.");

  return prisma.conciliaciones_insumos.findMany({
    where: { insumos_id: id, empresas_id: empresasId },
    include: {
      usuarios: { select: { id: true, nombre: true } },
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
  });
};

export {
  listar,
  obtener,
  crear,
  actualizar,
  eliminar,
  ajustarInventario,
  conciliarInventario,
  listarConciliaciones,
};
