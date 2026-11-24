import prisma from "../../db/prisma.js";
import { fechaColombiaToUTC } from "../../utils/timezone.js";
import { construirRangoFecha } from "../../utils/rangoFecha.js";
import { validarProductos, validarInsumos } from "../../utils/pertenencia.js";
import { asegurarStockNoNegativo, validarCantidadesEnteras } from "../../utils/stock.js";
import { noEncontrado } from "../../utils/errors.js";
import { asegurarBaseInsumo, recalcularInsumo } from "../../utils/inventarioInsumos.js";

const recalcularCostoPromedioProducto = async (tx, productosId) => {
  const lotes = await tx.lotes_produccion_items.findMany({
    where: { productos_id: productosId, lotes_produccion: { anulado: false } },
    select: { cantidad: true, costo_unitario: true },
  });

  const unidades = lotes.reduce((s, i) => s + Number(i.cantidad), 0);
  const valor = lotes.reduce((s, i) => s + Number(i.cantidad) * Number(i.costo_unitario), 0);
  const completo = lotes.length > 0 && lotes.every((i) => Number(i.costo_unitario) > 0);

  const estado = lotes.length === 0 ? "sin_costo_verificable" : completo && valor > 0 ? "historico_calculado" : "incompleto";

  return tx.productos.update({
    where: { id: productosId },
    data: {
      costo_promedio: completo && unidades > 0 && valor > 0 ? valor / unidades : null,
      costo_promedio_estado: estado,
    },
  });
};

// Captura una fotografía independiente de los productos y movimientos de una
// versión. Los valores Decimal se convierten a Number para almacenarlos en JSON.
const obtenerSnapshotsLote = async (tx, loteId, soloMovimientosSinEdicion = false) => {
  const [items, movimientos] = await Promise.all([
    tx.lotes_produccion_items.findMany({
      where: { lotes_produccion_id: loteId },
      include: { productos: { select: { id: true, nombre: true } } },
      orderBy: { id: "asc" },
    }),

    tx.movimientos_insumos.findMany({
      where: {
        lotes_produccion_id: loteId,
        ...(soloMovimientosSinEdicion ? { edicion_id: null } : {}),
      },
      include: {
        insumos: {
          select: { id: true, nombre: true, unidad_medida: true },
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
      costo_total: costoTotal,
      productos_snapshot: snapshots.productos,
      insumos_snapshot: snapshots.insumos,
    },
  });

  // Solo vincula movimientos que todavía no pertenecen a una versión.
  // Los movimientos anulados de ediciones anteriores conservan su asociación.
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
        usuarios: { select: { id: true, nombre: true } },
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
    where: { id, empresas_id: empresasId },
    include: {
      usuarios: { select: { id: true, nombre: true } },

      lotes_produccion_items: {
        include: { productos: true },
      },

      movimientos_insumos: {
        include: { insumos: true, edicion: true },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
      },

      ediciones: {
        include: {
          usuarios: { select: { id: true, nombre: true } },
        },
        orderBy: { numero_edicion: "asc" },
      },
    },
  });

const crear = async (empresasId, usuariosId, { fecha, notas, items, insumos_reales }) => {
  return prisma.$transaction(async (tx) => {
    validarCantidadesEnteras(items);

    await validarProductos(
      tx,
      empresasId,
      items.map((i) => i.productos_id),
    );

    await validarInsumos(
      tx,
      empresasId,
      (insumos_reales ?? []).map((i) => i.insumos_id),
    );

    let costoTotal = 0;
    const movimientos = [];

    if (insumos_reales && Array.isArray(insumos_reales) && insumos_reales.length > 0) {
      for (const ir of insumos_reales) {
        const insumo = await tx.insumos.findUnique({
          where: { id: ir.insumos_id },
        });

        if (!insumo) continue;

        if (Number(insumo.stock_actual) < Number(ir.cantidad)) {
          throw new Error(
            `Insumo insuficiente: "${insumo.nombre}". Disponible: ${insumo.stock_actual} ${insumo.unidad_medida}, utilizado: ${ir.cantidad}.`,
          );
        }

        if (Number(ir.cantidad) > 0 && !(Number(insumo.precio_unidad) > 0)) {
          throw new Error(
            `El insumo "${insumo.nombre}" no tiene un costo promedio verificable. Registra su costo inicial desde Insumos antes de producir.`,
          );
        }
      }

      for (const ir of insumos_reales ?? []) {
        const cantidad = Number(ir.cantidad);

        if (!Number.isFinite(cantidad) || cantidad <= 0) {
          throw new Error("Las cantidades de los insumos deben ser mayores que cero.");
        }

        const insumo = await tx.insumos.findUnique({
          where: { id: ir.insumos_id },
        });

        if (!insumo) continue;

        const costo = Number(ir.cantidad) * Number(insumo.precio_unidad ?? 0);

        costoTotal += costo;

        movimientos.push({
          insumos_id: ir.insumos_id,
          tipo: "salida",
          cantidad: Number(ir.cantidad),
          costo_total: costo,
          nota: `Lote de produccion`,
          usuarios_id: usuariosId,
        });

        await asegurarBaseInsumo(tx, insumo);

        await tx.insumos.update({
          where: { id: ir.insumos_id },
          data: {
            stock_actual: {
              decrement: Number(ir.cantidad),
            },
          },
        });
      }
    } else {
      const insumosTotales = {};

      for (const item of items) {
        const recetas = await tx.recetas.findMany({
          where: { productos_id: item.productos_id },
          include: { insumos: true },
        });

        for (const r of recetas) {
          const cantidadUsada = Number(r.cantidad) * item.cantidad;

          insumosTotales[r.insumos_id] = (insumosTotales[r.insumos_id] || 0) + cantidadUsada;
        }
      }

      for (const [insumoId, cantidadNecesaria] of Object.entries(insumosTotales)) {
        const insumo = await tx.insumos.findUnique({
          where: { id: Number(insumoId) },
        });

        if (Number(insumo.stock_actual) < cantidadNecesaria) {
          throw new Error(
            `Insumo insuficiente: "${insumo.nombre}". Disponible: ${insumo.stock_actual} ${insumo.unidad_medida}, necesario: ${cantidadNecesaria}.`,
          );
        }
      }

      // Costo exacto por item: como aquí sí sabemos qué receta corresponde a
      // cada producto, se acumula el costo item por item (no solo el total
      // global) para poder calcular su costo_unitario real más abajo.
      for (const item of items) {
        const recetas = await tx.recetas.findMany({
          where: { productos_id: item.productos_id },
          include: { insumos: true },
        });

        let costoItem = 0;

        if (recetas.length === 0) {
          // Producto de reventa (sin receta): el costo no sale de insumos,
          // se ingresa manualmente como el total pagado por ese producto en
          // el lote. No se calcula a partir de una receta inexistente.
          costoItem = Number(item.costo_total ?? 0);
          costoTotal += costoItem;
        } else {
          for (const r of recetas) {
            const cantidadUsada = Number(r.cantidad) * item.cantidad;

            if (cantidadUsada > 0 && !(Number(r.insumos.precio_unidad) > 0)) {
              throw new Error(
                `El insumo "${r.insumos.nombre}" no tiene un costo promedio verificable. Registra su costo inicial desde Insumos antes de producir.`,
              );
            }

            const costoInsumo = cantidadUsada * Number(r.insumos.precio_unidad ?? 0);

            costoItem += costoInsumo;
            costoTotal += costoInsumo;

            movimientos.push({
              insumos_id: r.insumos_id,
              tipo: "salida",
              cantidad: cantidadUsada,
              costo_total: costoInsumo,
              nota: `Lote de produccion`,
              usuarios_id: usuariosId,
            });

            await asegurarBaseInsumo(tx, r.insumos);

            await tx.insumos.update({
              where: { id: r.insumos_id },
              data: {
                stock_actual: { decrement: cantidadUsada },
              },
            });
          }
        }

        item.__costoCalculado = costoItem;
      }
    }

    await asegurarStockNoNegativo(tx, {
      insumos: movimientos.map((m) => m.insumos_id),
    });

    const totalUnidadesLote = items.reduce((s, i) => s + Number(i.cantidad), 0);

    const costoUnitarioPromedioLote = totalUnidadesLote > 0 ? costoTotal / totalUnidadesLote : 0;

    const lote = await tx.lotes_produccion.create({
      data: {
        empresas_id: empresasId,
        usuarios_id: usuariosId,
        fecha: fechaColombiaToUTC(fecha),
        notas,
        costo_total: costoTotal,

        lotes_produccion_items: {
          create: items.map((i) => ({
            productos_id: i.productos_id,
            cantidad: i.cantidad,
            costo_unitario:
              i.__costoCalculado != null && Number(i.cantidad) > 0 ? i.__costoCalculado / Number(i.cantidad) : costoUnitarioPromedioLote,
          })),
        },
      },
      include: { lotes_produccion_items: true },
    });

    if (movimientos.length > 0) {
      await tx.movimientos_insumos.createMany({
        data: movimientos.map((m) => ({
          ...m,
          lotes_produccion_id: lote.id,
        })),
      });

      for (const insumoId of new Set(movimientos.map((m) => m.insumos_id))) {
        await recalcularInsumo(tx, insumoId);
      }
    }

    for (const item of items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { increment: item.cantidad } },
      });

      await recalcularCostoPromedioProducto(tx, item.productos_id);
    }

    // Todo lote nuevo nace con su versión original (edición 0).
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
const actualizar = async (id, empresasId, usuariosId, { notas, items, insumos_reales }) => {
  return prisma.$transaction(async (tx) => {
    const lote = await tx.lotes_produccion.findFirst({
      where: { id, empresas_id: empresasId, anulado: false },
      include: {
        lotes_produccion_items: true,
        movimientos_insumos: true,
        ediciones: { orderBy: { numero_edicion: "asc" } },
      },
    });

    if (!lote) throw noEncontrado("Lote no encontrado.");

    // Los lotes creados antes del historial se conservan como un registro
    // previo incompleto: no es posible reconstruir con certeza cada edición
    // antigua, pero sí preservar los productos y movimientos que existen.
    let numeroNuevaEdicion = 1;

    if (!lote.ediciones.length) {
      await registrarEdicionLote(tx, {
        loteId: id,
        usuariosId: lote.usuarios_id,
        numeroEdicion: 0,
        tipoRegistro: "historial_previo",
        estado: "incompleto",
        notas: lote.notas,
        costoTotal: lote.costo_total,
        soloMovimientosSinEdicion: false,
      });

      await tx.movimientos_insumos.updateMany({
        where: { lotes_produccion_id: id, edicion_id: null },
        data: {
          edicion_id: (
            await tx.lotes_produccion_ediciones.findFirst({
              where: { lote_id: id, numero_edicion: 0 },
              select: { id: true },
            })
          ).id,
        },
      });
    } else {
      numeroNuevaEdicion = Math.max(...lote.ediciones.map((e) => e.numero_edicion)) + 1;

      await tx.lotes_produccion_ediciones.updateMany({
        where: { lote_id: id, estado: "vigente" },
        data: { estado: "reemplazada" },
      });
    }

    validarCantidadesEnteras(items);

    await validarProductos(
      tx,
      empresasId,
      items.map((i) => i.productos_id),
    );

    await validarInsumos(
      tx,
      empresasId,
      (insumos_reales ?? []).map((i) => i.insumos_id),
    );

    // Revertir stock de productos producidos anteriormente
    for (const item of lote.lotes_produccion_items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { decrement: item.cantidad } },
      });
    }

    // Anular los movimientos anteriores y reconstruir el inventario valorizado.
    // Devolver solo la cantidad no recupera el costo promedio cuando el stock
    // quedó en cero después de la producción anterior.
    const insumosAfectados = [
      ...new Set(lote.movimientos_insumos.filter((mov) => mov.tipo === "salida" && !mov.anulado).map((mov) => mov.insumos_id)),
    ];

    await tx.movimientos_insumos.updateMany({
      where: { lotes_produccion_id: id, anulado: false },
      data: { anulado: true },
    });

    for (const insumoId of insumosAfectados) {
      const insumo = await tx.insumos.findUnique({
        where: { id: insumoId },
      });

      if (insumo?.stock_base != null && insumo?.fecha_base) {
        // Recupera stock y precio promedio desde la base y movimientos vigentes.
        await recalcularInsumo(tx, insumoId);
      } else {
        // Compatibilidad con movimientos anteriores al inventario valorizado:
        // se restaura la cantidad sin inventar un costo.
        const movimientosLegacy = lote.movimientos_insumos.filter(
          (mov) => mov.insumos_id === insumoId && mov.tipo === "salida" && !mov.anulado,
        );

        for (const mov of movimientosLegacy) {
          await tx.insumos.update({
            where: { id: insumoId },
            data: {
              stock_actual: { increment: Number(mov.cantidad) },
            },
          });
        }
      }
    }

    // Los items se reemplazan; los movimientos anteriores quedan anulados
    // para conservar la trazabilidad del consumo y su costo histórico.
    await tx.lotes_produccion_items.deleteMany({
      where: { lotes_produccion_id: id },
    });

    // Recalcular con los nuevos datos (misma lógica que crear)
    let costoTotal = 0;
    const movimientos = [];

    if (insumos_reales?.length) {
      for (const ir of insumos_reales) {
        const insumo = await tx.insumos.findUnique({
          where: { id: ir.insumos_id },
        });

        if (!insumo) continue;

        if (Number(insumo.stock_actual) < Number(ir.cantidad)) {
          throw new Error(`Insumo insuficiente: "${insumo.nombre}". Disponible: ${insumo.stock_actual}.`);
        }

        if (Number(ir.cantidad) > 0 && !(Number(insumo.precio_unidad) > 0)) {
          throw new Error(
            `El insumo "${insumo.nombre}" no tiene un costo promedio verificable. Registra su costo inicial desde Insumos antes de producir.`,
          );
        }
      }

      for (const ir of insumos_reales ?? []) {
        const cantidad = Number(ir.cantidad);

        if (!Number.isFinite(cantidad) || cantidad <= 0) {
          throw new Error("Las cantidades de los insumos deben ser mayores que cero.");
        }

        const insumo = await tx.insumos.findUnique({
          where: { id: ir.insumos_id },
        });

        if (!insumo) continue;

        const costo = Number(ir.cantidad) * Number(insumo.precio_unidad ?? 0);

        costoTotal += costo;

        movimientos.push({
          insumos_id: ir.insumos_id,
          tipo: "salida",
          cantidad: Number(ir.cantidad),
          costo_total: costo,
          nota: `Lote de produccion (editado)`,
          usuarios_id: usuariosId,
        });

        await asegurarBaseInsumo(tx, insumo);

        await tx.insumos.update({
          where: { id: ir.insumos_id },
          data: {
            stock_actual: { decrement: Number(ir.cantidad) },
          },
        });
      }
    } else {
      // Rama de receta (igual a crear): faltaba por completo aquí, así que
      // editar un lote sin insumos_reales no descontaba insumos ni calculaba
      // costo. Se replica la misma lógica de validación + cálculo por item.
      const insumosTotales = {};

      for (const item of items) {
        const recetas = await tx.recetas.findMany({
          where: { productos_id: item.productos_id },
          include: { insumos: true },
        });

        for (const r of recetas) {
          const cantidadUsada = Number(r.cantidad) * item.cantidad;

          insumosTotales[r.insumos_id] = (insumosTotales[r.insumos_id] || 0) + cantidadUsada;
        }
      }

      for (const [insumoId, cantidadNecesaria] of Object.entries(insumosTotales)) {
        const insumo = await tx.insumos.findUnique({
          where: { id: Number(insumoId) },
        });

        if (Number(insumo.stock_actual) < cantidadNecesaria) {
          throw new Error(
            `Insumo insuficiente: "${insumo.nombre}". Disponible: ${insumo.stock_actual} ${insumo.unidad_medida}, necesario: ${cantidadNecesaria}.`,
          );
        }
      }

      for (const item of items) {
        const recetas = await tx.recetas.findMany({
          where: { productos_id: item.productos_id },
          include: { insumos: true },
        });

        let costoItem = 0;

        if (recetas.length === 0) {
          costoItem = Number(item.costo_total ?? 0);
          costoTotal += costoItem;
        } else {
          for (const r of recetas) {
            const cantidadUsada = Number(r.cantidad) * item.cantidad;

            if (cantidadUsada > 0 && !(Number(r.insumos.precio_unidad) > 0)) {
              throw new Error(
                `El insumo "${r.insumos.nombre}" no tiene un costo promedio verificable. Registra su costo inicial desde Insumos antes de producir.`,
              );
            }

            const costoInsumo = cantidadUsada * Number(r.insumos.precio_unidad ?? 0);

            costoItem += costoInsumo;
            costoTotal += costoInsumo;

            movimientos.push({
              insumos_id: r.insumos_id,
              tipo: "salida",
              cantidad: cantidadUsada,
              costo_total: costoInsumo,
              nota: `Lote de produccion (editado)`,
              usuarios_id: usuariosId,
            });

            await asegurarBaseInsumo(tx, r.insumos);

            await tx.insumos.update({
              where: { id: r.insumos_id },
              data: {
                stock_actual: { decrement: cantidadUsada },
              },
            });
          }
        }

        item.__costoCalculado = costoItem;
      }
    }
    await asegurarStockNoNegativo(tx, {
      insumos: movimientos.map((m) => m.insumos_id),
    });

    const totalUnidadesLote = items.reduce((s, i) => s + Number(i.cantidad), 0);

    const costoUnitarioPromedioLote = totalUnidadesLote > 0 ? costoTotal / totalUnidadesLote : 0;

    // Crear nuevos items
    await tx.lotes_produccion_items.createMany({
      data: items.map((i) => ({
        lotes_produccion_id: id,
        productos_id: i.productos_id,
        cantidad: i.cantidad,
        costo_unitario:
          i.__costoCalculado != null && Number(i.cantidad) > 0 ? i.__costoCalculado / Number(i.cantidad) : costoUnitarioPromedioLote,
      })),
    });

    if (movimientos.length) {
      await tx.movimientos_insumos.createMany({
        data: movimientos.map((m) => ({
          ...m,
          lotes_produccion_id: id,
        })),
      });

      for (const insumoId of new Set(movimientos.map((m) => m.insumos_id))) {
        await recalcularInsumo(tx, insumoId);
      }
    }

    // Sumar stock nuevo
    for (const item of items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { increment: item.cantidad } },
      });
    }

    await asegurarStockNoNegativo(
      tx,
      {
        productos: [...lote.lotes_produccion_items, ...items].map((i) => i.productos_id),
      },
      {
        mensajeProducto: (p) =>
          'No se puede editar el lote: ya se vendieron unidades de "' +
          p.nombre +
          '" y el stock quedaría en ' +
          p.stock_actual +
          ". Ajusta o anula esas ventas primero.",
      },
    );

    const actualizado = await tx.lotes_produccion.update({
      where: { id },
      data: { notas, costo_total: costoTotal },
    });

    // Guarda la fotografía completa de esta nueva versión y vincula únicamente
    // los movimientos recién creados. Los anteriores permanecen en su edición.
    await registrarEdicionLote(tx, {
      loteId: id,
      usuariosId,
      numeroEdicion: numeroNuevaEdicion,
      tipoRegistro: "edicion",
      estado: "vigente",
      notas,
      costoTotal,
    });

    for (const productoId of new Set([...lote.lotes_produccion_items.map((i) => i.productos_id), ...items.map((i) => i.productos_id)])) {
      await recalcularCostoPromedioProducto(tx, productoId);
    }

    return actualizado;
  });
};

const anular = async (id, empresasId, motivo) => {
  return prisma.$transaction(async (tx) => {
    const lote = await tx.lotes_produccion.findFirst({
      where: { id, empresas_id: empresasId, anulado: false },
      include: {
        lotes_produccion_items: true,
        movimientos_insumos: true,
        ediciones: true,
      },
    });

    if (!lote) {
      throw noEncontrado("Lote no encontrado o ya anulado.");
    }

    // Revertir stock de productos
    for (const item of lote.lotes_produccion_items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { decrement: item.cantidad } },
      });
    }

    await asegurarStockNoNegativo(
      tx,
      {
        productos: lote.lotes_produccion_items.map((i) => i.productos_id),
      },
      {
        mensajeProducto: (p) =>
          'No se puede anular el lote: ya se vendieron unidades de "' +
          p.nombre +
          '" y el stock quedaría en ' +
          p.stock_actual +
          ". Ajusta o anula esas ventas primero.",
      },
    );

    // Anular los movimientos de consumo. Si el insumo ya tiene línea base,
    // reconstruimos cantidad y promedio desde el historial valorizado.
    const insumosAfectados = [
      ...new Set(lote.movimientos_insumos.filter((m) => m.tipo === "salida" && !m.anulado).map((m) => m.insumos_id)),
    ];

    await tx.movimientos_insumos.updateMany({
      where: {
        lotes_produccion_id: id,
        anulado: false,
      },
      data: { anulado: true },
    });

    for (const insumoId of insumosAfectados) {
      const insumo = await tx.insumos.findUnique({
        where: { id: insumoId },
      });

      if (insumo?.stock_base != null && insumo?.fecha_base) {
        await recalcularInsumo(tx, insumoId);
      } else {
        const movimientosLegacy = lote.movimientos_insumos.filter((m) => m.insumos_id === insumoId && m.tipo === "salida" && !m.anulado);

        for (const mov of movimientosLegacy) {
          await tx.insumos.update({
            where: { id: insumoId },
            data: {
              stock_actual: {
                increment: Number(mov.cantidad),
              },
            },
          });
        }
      }
    }

    await tx.lotes_produccion_ediciones.updateMany({
      where: {
        lote_id: id,
        estado: "vigente",
      },
      data: { estado: "anulada" },
    });

    const anulado = await tx.lotes_produccion.update({
      where: { id },
      data: {
        anulado: true,
        motivo_anulacion: motivo,
      },
    });

    for (const productoId of new Set(lote.lotes_produccion_items.map((i) => i.productos_id))) {
      await recalcularCostoPromedioProducto(tx, productoId);
    }

    return anulado;
  });
};

export { listar, obtener, crear, actualizar, anular };
