import prisma from "../../db/prisma.js";
import { fechaColombiaToUTC } from "../../utils/timezone.js";
import { construirRangoFecha } from "../../utils/rangoFecha.js";
import { validarProductos, validarInsumos } from "../../utils/pertenencia.js";
import { asegurarStockNoNegativo, validarCantidadesEnteras } from "../../utils/stock.js";
import { noEncontrado } from "../../utils/errors.js";
import { asegurarBaseInsumo, recalcularInsumo } from "../../utils/inventarioInsumos.js";

const errorServicio = (mensaje, status = 400) => Object.assign(new Error(mensaje), { status });

const redondear = (valor, decimales = 4) => {
  const factor = 10 ** decimales;
  return Math.round((Number(valor) + Number.EPSILON) * factor) / factor;
};

const validarItemsLote = (items) => {
  if (!Array.isArray(items) || items.length !== 1) {
    throw errorServicio("Cada lote de producción debe contener exactamente un producto.");
  }

  const item = items[0];

  if (!item || !Number.isInteger(Number(item.productos_id)) || Number(item.productos_id) <= 0) {
    throw errorServicio("El producto del lote no es válido.");
  }

  validarCantidadesEnteras(items);

  return item;
};

const validarCostoManual = (item) => {
  const costo = Number(item.costo_total ?? 0);

  if (!Number.isFinite(costo) || costo < 0) {
    throw errorServicio("El costo total ingresado para el producto no es válido.");
  }

  return redondear(costo, 2);
};

// Se permiten cantidades de cero porque un ingrediente puede no haberse utilizado.
// Las cantidades negativas siguen estando prohibidas.
const validarCantidadInsumo = (insumoId, cantidad) => {
  const id = Number(insumoId);
  const qty = Number(cantidad);

  if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(qty) || qty < 0) {
    throw errorServicio("Hay un insumo o una cantidad de consumo inválida.");
  }

  if (Math.abs(qty * 1000 - Math.round(qty * 1000)) > 0.000001) {
    throw errorServicio("Las cantidades de insumos admiten máximo tres decimales.");
  }

  return { id, qty: redondear(qty, 3) };
};

const recalcularCostoPromedioProducto = async (tx, productosId) => {
  const lotes = await tx.lotes_produccion_items.findMany({
    where: {
      productos_id: productosId,
      lotes_produccion: { anulado: false },
    },
    select: {
      cantidad: true,
      costo_unitario: true,
    },
  });

  const unidades = lotes.reduce((s, item) => s + Number(item.cantidad), 0);

  const valor = lotes.reduce((s, item) => s + Number(item.cantidad) * Number(item.costo_unitario), 0);

  const completo = lotes.length > 0 && lotes.every((item) => Number(item.costo_unitario) > 0);

  const estado = lotes.length === 0 ? "sin_costo_verificable" : completo && valor > 0 ? "historico_calculado" : "incompleto";

  return tx.productos.update({
    where: { id: productosId },
    data: {
      costo_promedio: completo && unidades > 0 && valor > 0 ? redondear(valor / unidades, 4) : null,
      costo_promedio_estado: estado,
    },
  });
};

const bloquearInsumos = async (tx, insumosIds) => {
  const ids = [...new Set(insumosIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b);

  for (const id of ids) {
    await tx.$queryRaw`
      SELECT id
      FROM insumos
      WHERE id = ${id}
      FOR UPDATE
    `;
  }

  return ids;
};

const validarCostoInsumo = (insumo) => {
  const costo = Number(insumo?.precio_unidad);

  const baseValorizada =
    insumo?.stock_base != null && insumo?.valor_base != null && insumo?.fecha_base != null && insumo?.movimiento_base_id != null;

  const estadoVerificable = insumo?.estado_costo === "verificado" || insumo?.estado_costo === "historico_calculado";

  if (!baseValorizada || !estadoVerificable || !Number.isFinite(costo) || costo <= 0) {
    throw errorServicio(
      `El insumo "${insumo?.nombre ?? "desconocido"}" no tiene un costo promedio verificable. Registra o concilia su costo antes de producir.`,
      409,
    );
  }

  return costo;
};

const validarMovimientosFueraBase = async (tx, movimientos) => {
  for (const movimiento of movimientos) {
    if (movimiento.anulado) continue;

    const insumo = await tx.insumos.findUnique({
      where: { id: movimiento.insumos_id },
      select: {
        nombre: true,
        stock_base: true,
        valor_base: true,
        fecha_base: true,
        movimiento_base_id: true,
      },
    });

    if (!insumo) {
      throw errorServicio(`No se encontró el insumo ${movimiento.insumos_id}.`, 409);
    }

    const camposEstructurales = [insumo.stock_base, insumo.fecha_base, insumo.movimiento_base_id];

    const tieneBaseCompleta = camposEstructurales.every((valor) => valor != null);

    const tieneBaseParcial = camposEstructurales.some((valor) => valor != null) && !tieneBaseCompleta;

    if (tieneBaseParcial || (insumo.stock_base == null && insumo.valor_base != null)) {
      throw errorServicio(
        `El insumo "${insumo.nombre}" tiene una base histórica inconsistente. Debe revisarse antes de modificar la producción.`,
        409,
      );
    }

    if (tieneBaseCompleta && movimiento.id <= Number(insumo.movimiento_base_id)) {
      throw errorServicio(
        `No se puede modificar esta producción porque el insumo "${insumo.nombre}" tiene movimientos anteriores a su base histórica.`,
        409,
      );
    }
  }
};

const obtenerSnapshotsLote = async (tx, loteId, soloMovimientosSinEdicion = false) => {
  const [items, movimientos] = await Promise.all([
    tx.lotes_produccion_items.findMany({
      where: { lotes_produccion_id: loteId },
      include: {
        productos: {
          select: { id: true, nombre: true },
        },
      },
      orderBy: { id: "asc" },
    }),

    tx.movimientos_insumos.findMany({
      where: {
        lotes_produccion_id: loteId,
        ...(soloMovimientosSinEdicion ? { edicion_id: null } : {}),
      },
      include: {
        insumos: {
          select: {
            id: true,
            nombre: true,
            unidad_medida: true,
          },
        },
      },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
    }),
  ]);

  return {
    productos: items.map((item) => ({
      productos_id: item.productos_id,
      nombre: item.productos?.nombre ?? null,
      cantidad: Number(item.cantidad),
      costo_unitario: Number(item.costo_unitario ?? 0),
    })),

    insumos: movimientos.map((mov) => ({
      movimiento_id: mov.id,
      insumos_id: mov.insumos_id,
      nombre: mov.insumos?.nombre ?? null,
      unidad_medida: mov.insumos?.unidad_medida ?? null,
      tipo: mov.tipo,
      cantidad: Number(mov.cantidad),
      costo_total: mov.costo_total == null ? null : Number(mov.costo_total),
      anulado: Boolean(mov.anulado),
      fecha: mov.created_at?.toISOString?.() ?? null,
      nota: mov.nota ?? null,
    })),
  };
};

const registrarEdicionLote = async (
  tx,
  {
    loteId,
    usuariosId,
    numeroEdicion,
    tipoRegistro = "edicion",
    estado = "vigente",
    notas = null,
    costoTotal = 0,
    soloMovimientosSinEdicion = true,
  },
) => {
  const snapshots = await obtenerSnapshotsLote(tx, loteId, soloMovimientosSinEdicion);

  const edicion = await tx.lotes_produccion_ediciones.create({
    data: {
      lote_id: loteId,
      usuarios_id: usuariosId,
      numero_edicion: numeroEdicion,
      tipo_registro: tipoRegistro,
      estado,
      notas,
      costo_total: redondear(costoTotal, 2),
      productos_snapshot: snapshots.productos,
      insumos_snapshot: snapshots.insumos,
    },
  });

  if (soloMovimientosSinEdicion) {
    await tx.movimientos_insumos.updateMany({
      where: {
        lotes_produccion_id: loteId,
        edicion_id: null,
      },
      data: { edicion_id: edicion.id },
    });
  }

  return edicion;
};

const registrarHistorialPrevioSiHaceFalta = async (tx, lote, usuariosId) => {
  if (lote.ediciones.length > 0) return;

  const edicionPrevia = await registrarEdicionLote(tx, {
    loteId: lote.id,
    usuariosId: lote.usuarios_id ?? usuariosId,
    numeroEdicion: 0,
    tipoRegistro: "historial_previo",
    estado: "incompleto",
    notas: lote.notas,
    costoTotal: lote.costo_total,
    soloMovimientosSinEdicion: false,
  });

  await tx.movimientos_insumos.updateMany({
    where: {
      lotes_produccion_id: lote.id,
      edicion_id: null,
    },
    data: { edicion_id: edicionPrevia.id },
  });
};

const listar = async (empresasId, { periodo = "dia", desde, hasta, productos_id, page = 1, limit = 10 } = {}) => {
  const rangoFecha = construirRangoFecha({ periodo, desde, hasta });
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    empresas_id: empresasId,
    anulado: false,
    ...(rangoFecha && { fecha: rangoFecha }),
    ...(productos_id && {
      lotes_produccion_items: {
        some: { productos_id },
      },
    }),
  };

  const [data, total] = await Promise.all([
    prisma.lotes_produccion.findMany({
      where,
      orderBy: [{ fecha: "desc" }, { created_at: "desc" }, { id: "desc" }],
      skip,
      take: Number(limit),
      include: {
        usuarios: {
          select: { id: true, nombre: true },
        },
        lotes_produccion_items: {
          include: { productos: true },
        },
      },
    }),

    prisma.lotes_produccion.count({ where }),
  ]);

  return { rows: data, count: total };
};

const obtener = async (id, empresasId) =>
  prisma.lotes_produccion.findFirst({
    where: {
      id,
      empresas_id: empresasId,
    },
    include: {
      usuarios: {
        select: { id: true, nombre: true },
      },

      lotes_produccion_items: {
        include: { productos: true },
      },

      movimientos_insumos: {
        include: {
          insumos: true,
          edicion: true,
        },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
      },

      ediciones: {
        include: {
          usuarios: {
            select: { id: true, nombre: true },
          },
        },
        orderBy: { numero_edicion: "asc" },
      },
    },
  });

/**
 * Determina el método de costeo del producto y prepara sus consumos.
 *
 * - Producto sin receta: siempre utiliza costo manual.
 * - Producto con receta y sin insumos_reales: utiliza la receta.
 * - Producto con receta y con insumos_reales: utiliza las cantidades reales.
 * - Los consumos reales pueden incluir cantidades cero.
 * - Se exige al menos un consumo positivo para productos con receta.
 */
const prepararConsumos = async (tx, item, insumosReales, insumosRealesEnviados) => {
  if (insumosRealesEnviados && !Array.isArray(insumosReales)) {
    throw errorServicio("Los consumos reales de insumos deben enviarse como una lista.");
  }

  const recetas = await tx.recetas.findMany({
    where: {
      productos_id: Number(item.productos_id),
    },
  });

  const consumos = new Map();

  // Un producto sin receta siempre se costea manualmente.
  // No se utilizan insumos_reales para cambiar su método de costeo.
  if (recetas.length === 0) {
    return {
      consumos,
      recetas,
      usaCosteoInsumos: false,
    };
  }

  const agregarConsumo = (insumoId, cantidad) => {
    const { id, qty } = validarCantidadInsumo(insumoId, cantidad);

    // Una cantidad cero es válida, pero no genera movimiento de inventario.
    if (qty === 0) return;

    consumos.set(id, redondear((consumos.get(id) ?? 0) + qty, 3));
  };

  if (insumosRealesEnviados) {
    for (const insumo of insumosReales) {
      agregarConsumo(insumo?.insumos_id, insumo?.cantidad);
    }
  } else {
    for (const receta of recetas) {
      const cantidadReceta = Number(receta.cantidad);

      if (!Number.isFinite(cantidadReceta) || cantidadReceta <= 0) {
        throw errorServicio("Una receta contiene una cantidad de insumo inválida.");
      }

      agregarConsumo(receta.insumos_id, cantidadReceta * Number(item.cantidad));
    }
  }

  if (consumos.size === 0) {
    throw errorServicio("Debes registrar al menos un insumo con una cantidad mayor a cero para este producto.");
  }

  return {
    consumos,
    recetas,
    usaCosteoInsumos: true,
  };
};

const obtenerInsumosValorizados = async (tx, empresasId, consumos) => {
  const insumosIds = [...consumos.keys()];

  if (insumosIds.length === 0) {
    return {
      insumosIds,
      insumosMap: new Map(),
      precios: new Map(),
    };
  }

  await validarInsumos(tx, empresasId, insumosIds);
  await bloquearInsumos(tx, insumosIds);

  const registros = await tx.insumos.findMany({
    where: {
      id: { in: insumosIds },
      empresas_id: empresasId,
    },
  });

  const iniciales = new Map(registros.map((insumo) => [Number(insumo.id), insumo]));

  if (iniciales.size !== insumosIds.length) {
    throw errorServicio("Uno o más insumos no existen o no pertenecen a la empresa.", 409);
  }

  for (const insumoId of insumosIds) {
    const insumo = iniciales.get(insumoId);

    if (insumo.activo === false) {
      throw errorServicio(`El insumo "${insumo.nombre}" está inactivo.`, 409);
    }

    await asegurarBaseInsumo(tx, insumo);
  }

  const actualizados = await tx.insumos.findMany({
    where: {
      id: { in: insumosIds },
      empresas_id: empresasId,
    },
  });

  const insumosMap = new Map(actualizados.map((insumo) => [Number(insumo.id), insumo]));

  const precios = new Map();

  for (const [insumoId, cantidadNecesaria] of consumos) {
    const insumo = insumosMap.get(insumoId);

    if (!insumo || insumo.activo === false) {
      throw errorServicio(`No se puede utilizar el insumo ${insumoId}.`, 409);
    }

    const stockDisponible = Number(insumo.stock_actual ?? 0);

    if (stockDisponible < cantidadNecesaria) {
      throw errorServicio(
        `Insumo insuficiente: "${insumo.nombre}". Disponible: ${stockDisponible} ${insumo.unidad_medida}, necesario: ${cantidadNecesaria}.`,
        409,
      );
    }

    precios.set(insumoId, validarCostoInsumo(insumo));
  }

  return { insumosIds, insumosMap, precios };
};

const calcularCostoDesdeConsumos = (consumos, precios) => {
  let costoTotal = 0;

  const movimientos = [];

  for (const [insumoId, cantidad] of consumos) {
    const precio = precios.get(insumoId);

    if (precio == null) {
      throw errorServicio(`No se pudo obtener el costo del insumo ${insumoId}.`, 409);
    }

    const costo = redondear(cantidad * precio, 4);

    costoTotal += costo;

    movimientos.push({
      insumos_id: insumoId,
      tipo: "salida",
      cantidad: redondear(cantidad, 3),
      costo_total: costo,
    });
  }

  return {
    costoTotal: redondear(costoTotal, 4),
    movimientos,
  };
};

const crear = async (empresasId, usuariosId, datos = {}) => {
  return prisma.$transaction(async (tx) => {
    const { fecha, notas, items, insumos_reales } = datos ?? {};

    const insumosRealesEnviados = insumos_reales != null;

    const item = validarItemsLote(items);

    await validarProductos(tx, empresasId, [Number(item.productos_id)]);

    const { consumos, usaCosteoInsumos } = await prepararConsumos(tx, item, insumos_reales, insumosRealesEnviados);

    let costoTotal = 0;
    let movimientos = [];
    let insumosIds = [];

    if (usaCosteoInsumos) {
      const valorizados = await obtenerInsumosValorizados(tx, empresasId, consumos);

      insumosIds = valorizados.insumosIds;

      const calculo = calcularCostoDesdeConsumos(consumos, valorizados.precios);

      costoTotal = calculo.costoTotal;
      movimientos = calculo.movimientos;
    } else {
      costoTotal = validarCostoManual(item);
    }

    const cantidadProducto = Number(item.cantidad);
    const costoUnitario = redondear(costoTotal / cantidadProducto, 4);

    const lote = await tx.lotes_produccion.create({
      data: {
        empresas_id: empresasId,
        usuarios_id: usuariosId,
        fecha: fechaColombiaToUTC(fecha),
        notas,
        costo_total: redondear(costoTotal, 2),

        lotes_produccion_items: {
          create: {
            productos_id: Number(item.productos_id),
            cantidad: cantidadProducto,
            costo_unitario: costoUnitario,
          },
        },
      },
      include: {
        lotes_produccion_items: true,
      },
    });

    if (movimientos.length > 0) {
      await tx.movimientos_insumos.createMany({
        data: movimientos.map((movimiento) => ({
          ...movimiento,
          lotes_produccion_id: lote.id,
          nota: "Lote de produccion",
          usuarios_id: usuariosId,
        })),
      });

      for (const insumoId of insumosIds) {
        await recalcularInsumo(tx, insumoId);
      }

      await asegurarStockNoNegativo(tx, {
        insumos: insumosIds,
      });
    }

    await tx.productos.update({
      where: {
        id: Number(item.productos_id),
      },
      data: {
        stock_actual: {
          increment: cantidadProducto,
        },
      },
    });

    await recalcularCostoPromedioProducto(tx, Number(item.productos_id));

    await registrarEdicionLote(tx, {
      loteId: lote.id,
      usuariosId,
      numeroEdicion: 0,
      tipoRegistro: "original",
      notas,
      costoTotal,
    });

    return lote;
  });
};

const actualizar = async (id, empresasId, usuariosId, datos = {}) => {
  return prisma.$transaction(async (tx) => {
    const { notas, items, insumos_reales } = datos ?? {};

    const insumosRealesEnviados = insumos_reales != null;

    const item = validarItemsLote(items);

    await tx.$queryRaw`
      SELECT id
      FROM lotes_produccion
      WHERE id = ${id}
        AND empresas_id = ${empresasId}
      FOR UPDATE
    `;

    const lote = await tx.lotes_produccion.findFirst({
      where: {
        id,
        empresas_id: empresasId,
        anulado: false,
      },
      include: {
        lotes_produccion_items: true,
        movimientos_insumos: true,
        ediciones: {
          orderBy: { numero_edicion: "asc" },
        },
      },
    });

    if (!lote) {
      throw noEncontrado("Lote no encontrado.");
    }

    await validarProductos(tx, empresasId, [Number(item.productos_id)]);

    if (lote.lotes_produccion_items.length !== 1) {
      throw errorServicio("Este lote antiguo no contiene exactamente un producto. Debe revisarse antes de editarlo.", 409);
    }

    const movimientosAnteriores = lote.movimientos_insumos.filter((mov) => mov.tipo === "salida" && !mov.anulado);

    const { consumos, usaCosteoInsumos } = await prepararConsumos(tx, item, insumos_reales, insumosRealesEnviados);

    const insumosNuevosIds = [...consumos.keys()];

    if (insumosNuevosIds.length > 0) {
      await validarInsumos(tx, empresasId, insumosNuevosIds);
    }

    const insumosBloqueados = [...new Set([...movimientosAnteriores.map((mov) => Number(mov.insumos_id)), ...insumosNuevosIds])];

    await bloquearInsumos(tx, insumosBloqueados);

    await validarMovimientosFueraBase(tx, movimientosAnteriores);

    await registrarHistorialPrevioSiHaceFalta(tx, lote, usuariosId);

    const numeroNuevaEdicion =
      lote.ediciones.length > 0 ? Math.max(...lote.ediciones.map((edicion) => Number(edicion.numero_edicion))) + 1 : 1;

    if (lote.ediciones.length > 0) {
      await tx.lotes_produccion_ediciones.updateMany({
        where: {
          lote_id: id,
          estado: "vigente",
        },
        data: {
          estado: "reemplazada",
        },
      });
    }

    const productoAnterior = lote.lotes_produccion_items[0];

    await tx.productos.update({
      where: { id: productoAnterior.productos_id },
      data: {
        stock_actual: {
          decrement: productoAnterior.cantidad,
        },
      },
    });

    await tx.movimientos_insumos.updateMany({
      where: {
        lotes_produccion_id: id,
        anulado: false,
      },
      data: {
        anulado: true,
      },
    });

    const cantidadesAnteriores = new Map();

    for (const mov of movimientosAnteriores) {
      const insumoId = Number(mov.insumos_id);

      cantidadesAnteriores.set(insumoId, redondear((cantidadesAnteriores.get(insumoId) ?? 0) + Number(mov.cantidad), 3));
    }

    for (const [insumoId, cantidad] of cantidadesAnteriores) {
      const insumo = await tx.insumos.findUnique({
        where: { id: insumoId },
      });

      if (!insumo) {
        throw errorServicio(`No se encontró el insumo ${insumoId} utilizado por el lote anterior.`, 409);
      }

      const tieneBase = insumo.stock_base != null && insumo.fecha_base != null && insumo.movimiento_base_id != null;

      if (tieneBase) {
        await recalcularInsumo(tx, insumoId);
      } else {
        await tx.insumos.update({
          where: { id: insumoId },
          data: {
            stock_actual: {
              increment: cantidad,
            },
            estado_costo: "sin_costo_verificable",
            precio_unidad: null,
          },
        });
      }
    }

    let costoTotal = 0;
    let movimientos = [];
    let insumosIds = [];

    if (usaCosteoInsumos) {
      const valorizados = await obtenerInsumosValorizados(tx, empresasId, consumos);

      insumosIds = valorizados.insumosIds;

      const calculo = calcularCostoDesdeConsumos(consumos, valorizados.precios);

      costoTotal = calculo.costoTotal;
      movimientos = calculo.movimientos;
    } else {
      // Los productos sin receta nunca toman el costo de sus movimientos
      // antiguos: el costo vigente se ingresa manualmente.
      costoTotal = validarCostoManual(item);
    }

    const cantidadProducto = Number(item.cantidad);
    const costoUnitario = redondear(costoTotal / cantidadProducto, 4);

    await tx.lotes_produccion_items.deleteMany({
      where: {
        lotes_produccion_id: id,
      },
    });

    await tx.lotes_produccion_items.create({
      data: {
        lotes_produccion_id: id,
        productos_id: Number(item.productos_id),
        cantidad: cantidadProducto,
        costo_unitario: costoUnitario,
      },
    });

    if (movimientos.length > 0) {
      await tx.movimientos_insumos.createMany({
        data: movimientos.map((movimiento) => ({
          ...movimiento,
          lotes_produccion_id: id,
          nota: "Lote de produccion (editado)",
          usuarios_id: usuariosId,
        })),
      });

      for (const insumoId of insumosIds) {
        await recalcularInsumo(tx, insumoId);
      }

      await asegurarStockNoNegativo(tx, {
        insumos: insumosIds,
      });
    }

    await tx.productos.update({
      where: {
        id: Number(item.productos_id),
      },
      data: {
        stock_actual: {
          increment: cantidadProducto,
        },
      },
    });

    await asegurarStockNoNegativo(
      tx,
      {
        productos: [productoAnterior.productos_id, Number(item.productos_id)],
      },
      {
        mensajeProducto: (producto) =>
          'No se puede editar el lote: ya se vendieron unidades de "' +
          producto.nombre +
          '" y el stock quedaría en ' +
          producto.stock_actual +
          ". Ajusta o anula esas ventas primero.",
      },
    );

    const actualizado = await tx.lotes_produccion.update({
      where: { id },
      data: {
        notas,
        costo_total: redondear(costoTotal, 2),
      },
    });

    await registrarEdicionLote(tx, {
      loteId: id,
      usuariosId,
      numeroEdicion: numeroNuevaEdicion,
      tipoRegistro: "edicion",
      estado: "vigente",
      notas,
      costoTotal,
    });

    await recalcularCostoPromedioProducto(tx, productoAnterior.productos_id);

    if (Number(item.productos_id) !== Number(productoAnterior.productos_id)) {
      await recalcularCostoPromedioProducto(tx, Number(item.productos_id));
    }

    return actualizado;
  });
};

const anular = async (id, empresasId, motivo) => {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id
      FROM lotes_produccion
      WHERE id = ${id}
        AND empresas_id = ${empresasId}
      FOR UPDATE
    `;
    const lote = await tx.lotes_produccion.findFirst({
      where: {
        id,
        empresas_id: empresasId,
        anulado: false,
      },
      include: {
        lotes_produccion_items: true,
        movimientos_insumos: true,
        ediciones: {
          orderBy: { numero_edicion: "asc" },
        },
      },
    });

    if (!lote) {
      throw noEncontrado("Lote no encontrado o ya anulado.");
    }

    if (lote.lotes_produccion_items.length !== 1) {
      throw errorServicio("Este lote no contiene exactamente un producto. Debe revisarse antes de anularlo.", 409);
    }

    const movimientosAnteriores = lote.movimientos_insumos.filter((mov) => mov.tipo === "salida" && !mov.anulado);

    const insumosIds = [...new Set(movimientosAnteriores.map((mov) => Number(mov.insumos_id)))];

    await bloquearInsumos(tx, insumosIds);

    await validarMovimientosFueraBase(tx, movimientosAnteriores);

    await registrarHistorialPrevioSiHaceFalta(tx, lote, lote.usuarios_id);

    const item = lote.lotes_produccion_items[0];

    await tx.productos.update({
      where: {
        id: item.productos_id,
      },
      data: {
        stock_actual: {
          decrement: item.cantidad,
        },
      },
    });

    await asegurarStockNoNegativo(
      tx,
      {
        productos: [item.productos_id],
      },
      {
        mensajeProducto: (producto) =>
          'No se puede anular el lote: ya se vendieron unidades de "' +
          producto.nombre +
          '" y el stock quedaría en ' +
          producto.stock_actual +
          ". Ajusta o anula esas ventas primero.",
      },
    );

    await tx.movimientos_insumos.updateMany({
      where: {
        lotes_produccion_id: id,
        anulado: false,
      },
      data: {
        anulado: true,
      },
    });

    const cantidadesAnteriores = new Map();

    for (const mov of movimientosAnteriores) {
      const insumoId = Number(mov.insumos_id);

      cantidadesAnteriores.set(insumoId, redondear((cantidadesAnteriores.get(insumoId) ?? 0) + Number(mov.cantidad), 3));
    }

    for (const [insumoId, cantidad] of cantidadesAnteriores) {
      const insumo = await tx.insumos.findUnique({
        where: { id: insumoId },
      });

      if (!insumo) {
        throw errorServicio(`No se encontró el insumo ${insumoId} utilizado por el lote.`, 409);
      }

      const tieneBase = insumo.stock_base != null && insumo.fecha_base != null && insumo.movimiento_base_id != null;

      if (tieneBase) {
        await recalcularInsumo(tx, insumoId);
      } else {
        await tx.insumos.update({
          where: { id: insumoId },
          data: {
            stock_actual: {
              increment: cantidad,
            },
            precio_unidad: null,
            estado_costo: "sin_costo_verificable",
          },
        });
      }
    }

    await tx.lotes_produccion_ediciones.updateMany({
      where: {
        lote_id: id,
        estado: "vigente",
      },
      data: {
        estado: "anulada",
      },
    });

    const anulado = await tx.lotes_produccion.update({
      where: { id },
      data: {
        anulado: true,
        motivo_anulacion: motivo,
      },
    });

    await recalcularCostoPromedioProducto(tx, item.productos_id);

    return anulado;
  });
};

export { listar, obtener, crear, actualizar, anular };
