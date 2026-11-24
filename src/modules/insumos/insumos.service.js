import prisma from "../../db/prisma.js";
import { noEncontrado } from "../../utils/errors.js";
import { asegurarBaseInsumo, recalcularInsumo } from "../../utils/inventarioInsumos.js";

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

const crear = async (empresasId, data) => prisma.insumos.create({ data: { ...data, empresas_id: empresasId } });

const actualizar = async (id, empresasId, data) =>
  prisma.$transaction(async (tx) => {
    const actual = await tx.insumos.findFirst({ where: { id, empresas_id: empresasId } });
    if (!actual) throw noEncontrado("Insumo no encontrado.");
    if (actual.stock_base != null && actual.fecha_base) {
      const cambiaStock = data.stock_actual != null && Number(data.stock_actual) !== Number(actual.stock_actual);
      const cambiaCosto = data.precio_unidad != null && Number(data.precio_unidad) !== Number(actual.precio_unidad);
      if (cambiaStock) {
        throw Object.assign(
          new Error(
            "El stock se actualiza desde compras de Caja y producción; no se puede modificar manualmente después de iniciar el inventario valorizado.",
          ),
          { status: 400 },
        );
      }
      if (cambiaCosto) {
        if (actual.estado_costo !== "sin_costo_verificable" || !(Number(data.precio_unidad) > 0)) {
          throw Object.assign(
            new Error(
              "El costo promedio se actualiza automáticamente. Solo puedes ingresar un costo inicial cuando el inventario quedó marcado sin costo verificable.",
            ),
            { status: 400 },
          );
        }
        await tx.insumos.update({
          where: { id },
          data: {
            valor_base: Number(actual.stock_base) * Number(data.precio_unidad),
            estado_costo: "historico_calculado",
          },
        });
        await recalcularInsumo(tx, id);
      }
      delete data.stock_actual;
      delete data.precio_unidad;
    }
    return tx.insumos.update({ where: { id }, data });
  });

const eliminar = async (id, empresasId) => {
  const { count } = await prisma.insumos.updateMany({
    where: { id, empresas_id: empresasId },
    data: { activo: false },
  });
  if (count === 0) throw noEncontrado("Insumo no encontrado.");
};

const ajustarInventario = async (id, empresasId, usuarioId, stockReal, motivo) => {
  if (!Number.isFinite(Number(stockReal)) || Number(stockReal) < 0) {
    throw Object.assign(new Error("El stock físico debe ser un número válido y no negativo."), { status: 400 });
  }

  if (typeof motivo !== "string" || !motivo.trim() || motivo.trim().length > 180) {
    throw Object.assign(new Error("El motivo es obligatorio y no puede superar 180 caracteres."), { status: 400 });
  }

  return prisma.$transaction(async (tx) => {
    const insumo = await tx.insumos.findFirst({
      where: {
        id,
        empresas_id: empresasId,
        activo: true,
      },
    });

    if (!insumo) {
      throw noEncontrado("Insumo no encontrado.");
    }

    const tieneStockBase = insumo.stock_base != null;
    const tieneFechaBase = insumo.fecha_base != null;

    if (tieneStockBase !== tieneFechaBase) {
      throw Object.assign(new Error("El inventario tiene una base histórica incompleta. Se requiere revisión antes de ajustarlo."), {
        status: 409,
      });
    }

    const insumoConBase = await asegurarBaseInsumo(tx, insumo);

    const stockActual = Number(insumo.stock_actual ?? 0);
    const stockContado = Math.round(Number(stockReal) * 1000) / 1000;

    const diferencia = Math.round((stockContado - stockActual) * 1000) / 1000;

    if (Math.abs(diferencia) < 0.0005) {
      return {
        ajustado: false,
        mensaje: "El inventario físico coincide con el registrado.",
        stock_actual: stockActual,
        stock_real: stockContado,
        diferencia: 0,
      };
    }

    let costoTotal = null;

    if (diferencia < 0) {
      const costoPromedio = Number(insumoConBase.precio_unidad ?? 0);

      const costoVerificable = insumoConBase.estado_costo === "verificado" || insumoConBase.estado_costo === "historico_calculado";

      if (costoVerificable && Number.isFinite(costoPromedio) && costoPromedio >= 0) {
        costoTotal = Math.round(Math.abs(diferencia) * costoPromedio * 10000) / 10000;
      }
    }

    const nota = `Ajuste físico: stock contado=${stockContado.toFixed(3)}. Motivo: ${motivo.trim()}`;

    await tx.movimientos_insumos.create({
      data: {
        insumos_id: id,
        tipo: "ajuste",
        cantidad: diferencia,
        costo_total: costoTotal,
        anulado: false,
        usuarios_id: usuarioId,
        nota,
      },
    });

    const actualizado = await recalcularInsumo(tx, id);

    return {
      ajustado: true,
      mensaje: "Inventario ajustado correctamente.",
      stock_anterior: stockActual,
      stock_real: stockContado,
      diferencia,
      insumo: actualizado,
    };
  });
};

export { listar, obtener, crear, actualizar, eliminar, ajustarInventario };
