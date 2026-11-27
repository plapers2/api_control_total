import prisma from "../../db/prisma.js";
import { fechaColombiaToUTC } from "../../utils/timezone.js";
import { construirRangoFecha } from "../../utils/rangoFecha.js";
import { noEncontrado } from "../../utils/errors.js";
import { validarCliente } from "../../utils/pertenencia.js";
import { asegurarStockNoNegativo, validarItemsVenta } from "../../utils/stock.js";
import { moverSaldo } from "../clientes/saldo.service.js";
import { registrarRecuperacionVenta, recalcularRecuperacionesVenta, recalcularFondo } from "../fondo-reposicion/fondo.service.js";

const badRequest = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });
const centavos = (n) => Math.round(Number(n) * 100);
const transaccionConReintento = async (operacion, maxIntentos = 3) => {
  for (let intento = 1; ; intento++) {
    try {
      return await prisma.$transaction(operacion);
    } catch (error) {
      if (error?.code !== "P2034" || intento >= maxIntentos) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 50 * intento));
    }
  }
};

const CONSUMO = "consumo_propio";
const CANALES = ["punto_venta", "domicilio", "encargo", CONSUMO];

// Consumo propio: sale stock pero no entra dinero (precio 0, sin cliente ni crédito)
const itemsSegunCanal = (canal, items) => (canal === CONSUMO ? items.map((i) => ({ ...i, precio_unitario: 0 })) : items);

const validarCanal = (canal) => {
  if (canal !== undefined && canal !== null && !CANALES.includes(canal)) throw badRequest("Canal inválido.");
};

// El domicilio solo cuenta cuando el canal es "domicilio"; en los demás canales vale 0.
// Se suma al total de la venta (y por tanto a caja y a las deudas), pero no a ventas_items,
// así que no infla la rentabilidad de los productos.
const resolverDomicilio = (canal, valor) => {
  if (canal !== "domicilio") return 0;
  const n = Number(valor ?? 0);
  if (!Number.isFinite(n) || n < 0) throw badRequest("El valor del domicilio debe ser un número válido, no negativo.");
  return n;
};

// Saldo a favor que se descuenta de la venta: requiere cliente y no puede pasar del total
const resolverSaldoUsado = (saldoUsado, clientesId, total) => {
  const n = Number(saldoUsado ?? 0);
  if (!Number.isFinite(n) || n < 0) throw badRequest("El saldo a favor a usar no es válido.");
  if (n === 0) return 0;
  if (!clientesId) throw badRequest("Para usar saldo a favor debes asignar un cliente.");
  if (centavos(n) > centavos(total)) throw badRequest("El saldo a favor no puede ser mayor al total de la venta.");
  return n;
};

const obtenerDiaISO = (valor) => {
  const fecha = valor instanceof Date ? valor : new Date(valor);

  if (!Number.isFinite(fecha.getTime())) return null;

  return fecha.toISOString().slice(0, 10);
};

const resolverCostoPromedioProducto = async (tx, producto, fechaVenta, creadoVenta) => {
  const diaVenta = obtenerDiaISO(fechaVenta);
  const instanteVenta = new Date(creadoVenta).getTime();

  if (!diaVenta || !Number.isFinite(instanteVenta)) {
    return { costo: null, estado: "incompleto" };
  }

  const itemsLotes = await tx.lotes_produccion_items.findMany({
    where: {
      productos_id: producto.id,
      lotes_produccion: {
        empresas_id: producto.empresas_id,
        anulado: false,
      },
    },
    select: {
      cantidad: true,
      costo_unitario: true,
      lotes_produccion: {
        select: {
          id: true,
          fecha: true,
          created_at: true,
          movimientos_insumos: {
            where: {
              tipo: "salida",
              anulado: false,
            },
            select: {
              costo_total: true,
            },
          },
        },
      },
    },
  });

  const lotes = itemsLotes
    .map((item) => {
      const lote = item.lotes_produccion;
      const cantidad = Number(item.cantidad);
      const costoRegistrado = Number(item.costo_unitario ?? 0);

      let costoUnitario = null;

      // Conservar el costo histórico positivo ya registrado.
      if (Number.isFinite(costoRegistrado) && costoRegistrado > 0) {
        costoUnitario = costoRegistrado;
      } else {
        const movimientos = lote.movimientos_insumos ?? [];

        // Recuperar el costo desde todos los consumos activos del lote.
        const consumosCompletos =
          movimientos.length > 0 &&
          movimientos.every((mov) => mov.costo_total != null && Number.isFinite(Number(mov.costo_total)) && Number(mov.costo_total) >= 0);

        if (consumosCompletos && Number.isFinite(cantidad) && cantidad > 0) {
          const costoTotal = movimientos.reduce((total, mov) => total + Number(mov.costo_total), 0);

          if (costoTotal > 0) {
            costoUnitario = costoTotal / cantidad;
          }
        }
      }

      return {
        id: lote.id,
        fecha: obtenerDiaISO(lote.fecha),
        createdAt: new Date(lote.created_at).getTime(),
        cantidad,
        costoUnitario,
      };
    })
    .filter((lote) => {
      if (!lote.fecha) return false;

      // No incluir producciones posteriores a la venta.
      if (lote.fecha < diaVenta) return true;
      if (lote.fecha > diaVenta) return false;

      // Si son del mismo día, respetar el orden real de creación.
      return Number.isFinite(lote.createdAt) && lote.createdAt <= instanteVenta;
    })
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.createdAt - b.createdAt || a.id - b.id);

  if (lotes.length === 0) {
    return { costo: null, estado: "sin_costo_verificable" };
  }

  let unidades = 0;
  let valorTotal = 0;
  let lotesSinCosto = 0;

  for (const lote of lotes) {
    if (!Number.isFinite(lote.cantidad) || lote.cantidad <= 0) {
      lotesSinCosto += 1;
      continue;
    }

    unidades += lote.cantidad;

    if (lote.costoUnitario == null || !Number.isFinite(lote.costoUnitario) || lote.costoUnitario <= 0) {
      lotesSinCosto += 1;
      continue;
    }

    valorTotal += lote.cantidad * lote.costoUnitario;
  }

  if (lotesSinCosto > 0) {
    return { costo: null, estado: "incompleto" };
  }

  if (unidades <= 0 || valorTotal <= 0) {
    return { costo: null, estado: "sin_costo_verificable" };
  }

  const costo = Math.round((valorTotal / unidades + Number.EPSILON) * 10000) / 10000;

  return {
    costo,
    estado: "historico_calculado",
  };
};

const listar = async (empresasId, { periodo = "dia", desde, hasta, page = 1, limit = 10, q } = {}) => {
  const rangoFecha = construirRangoFecha({ periodo, desde, hasta });
  const skip = (Number(page) - 1) * Number(limit);

  const texto = q?.trim();
  let busqueda = {};

  if (texto) {
    // El operator "contains" de Prisma con el adaptador @prisma/adapter-mariadb
    // hace bind del parámetro de texto con collation utf8mb4_bin sin importar la
    // collation real de la columna (utf8mb4_unicode_ci), lo que MariaDB rechaza
    // con "Illegal mix of collations" en cualquier LIKE, sin importar la
    // complejidad de la consulta. Por eso resolvemos el texto con SQL crudo
    // forzando COLLATE explícito en ambos lados, y solo usamos filtros de Prisma
    // con IDs numéricos (sin LIKE de por medio) en la consulta principal.
    const like = `%${texto}%`;

    const [productosMatch, clientesMatch, ventasPorNotas] = await Promise.all([
      prisma.$queryRaw`
        SELECT id FROM productos
        WHERE empresas_id = ${empresasId}
        AND nombre COLLATE utf8mb4_unicode_ci LIKE ${like} COLLATE utf8mb4_unicode_ci
      `,
      prisma.$queryRaw`
        SELECT id FROM clientes
        WHERE empresas_id = ${empresasId}
        AND nombre COLLATE utf8mb4_unicode_ci LIKE ${like} COLLATE utf8mb4_unicode_ci
      `,
      prisma.$queryRaw`
        SELECT id FROM ventas
        WHERE empresas_id = ${empresasId}
        AND notas COLLATE utf8mb4_unicode_ci LIKE ${like} COLLATE utf8mb4_unicode_ci
      `,
    ]);

    const productosIds = productosMatch.map((p) => p.id);
    const clientesIds = clientesMatch.map((c) => c.id);
    const ventaIdsPorNotas = ventasPorNotas.map((v) => v.id);

    busqueda = {
      OR: [
        ...(Number.isInteger(Number(texto)) ? [{ id: Number(texto) }] : []),
        ...(ventaIdsPorNotas.length ? [{ id: { in: ventaIdsPorNotas } }] : []),
        ...(clientesIds.length ? [{ clientes_id: { in: clientesIds } }] : []),
        ...(productosIds.length ? [{ ventas_items: { some: { productos_id: { in: productosIds } } } }] : []),
      ],
    };

    // Si ningún lado del OR quedó poblado, forzamos un resultado vacío en vez de
    // devolver todas las ventas (un OR: [] en Prisma no filtra nada).
    if (!busqueda.OR.length) {
      busqueda = { id: -1 };
    }
  }

  const where = {
    empresas_id: empresasId,
    anulada: false,
    ...(rangoFecha && { fecha: rangoFecha }),
    ...busqueda,
  };

  const [rows, count] = await Promise.all([
    prisma.ventas.findMany({
      where,
      orderBy: [{ fecha: "desc" }, { created_at: "desc" }, { id: "desc" }],
      skip,
      take: Number(limit),
      include: { clientes: true, usuarios: { select: { id: true, nombre: true } }, ventas_items: { include: { productos: true } } },
    }),
    prisma.ventas.count({ where }),
  ]);

  return { rows, count };
};

const obtener = async (id, empresasId) =>
  prisma.ventas.findFirst({
    where: { id, empresas_id: empresasId },
    include: {
      clientes: true,
      usuarios: { select: { id: true, nombre: true } },
      ventas_items: { include: { productos: true } },
      movimientos_caja: true,
      pagos_venta: true,
    },
  });

const crear = async (
  empresasId,
  usuariosId,
  {
    fecha,
    canal,
    valor_domicilio,
    notas,
    clientes_id: clienteEntrada,
    items: itemsEntrada,
    credito: creditoEntrada,
    abono_inicial,
    saldo_usado,
  },
) => {
  const esConsumo = canal === CONSUMO;
  const items = itemsSegunCanal(canal, itemsEntrada);
  const clientes_id = esConsumo ? null : clienteEntrada;
  const credito = esConsumo ? false : creditoEntrada;
  return transaccionConReintento(async (tx) => {
    validarItemsVenta(items);
    validarCanal(canal);
    const canalFinal = canal ?? "punto_venta";
    const domicilio = resolverDomicilio(canalFinal, valor_domicilio);
    await validarCliente(tx, empresasId, clientes_id);

    const fechaVenta = fechaColombiaToUTC(fecha);
    const creadoVenta = new Date();

    const costosPorProducto = new Map();
    for (const item of items) {
      const producto = await tx.productos.findFirst({
        where: { id: item.productos_id, empresas_id: empresasId, activo: true },
      });
      if (!producto) throw badRequest(`Producto ${item.productos_id} no encontrado.`);
      if (Number(producto.stock_actual) < item.cantidad)
        throw badRequest(`Stock insuficiente para "${producto.nombre}". Disponible: ${producto.stock_actual}.`);
      if (!costosPorProducto.has(item.productos_id))
        costosPorProducto.set(item.productos_id, await resolverCostoPromedioProducto(tx, producto, fechaVenta, creadoVenta));
    }

    const total = items.reduce((sum, i) => sum + Number(i.precio_unitario) * i.cantidad, 0) + domicilio;
    const usado = resolverSaldoUsado(saldo_usado, clientes_id, total);
    const restante = total - usado;
    const esCredito = !!credito;
    const montoAbono = esCredito ? Math.min(Number(abono_inicial || 0), restante) : restante;
    const pagadoTotal = usado + montoAbono;
    const estadoPago = centavos(pagadoTotal) >= centavos(total) ? "pagada" : pagadoTotal > 0 ? "parcial" : "pendiente";

    const venta = await tx.ventas.create({
      data: {
        empresas_id: empresasId,
        usuarios_id: usuariosId,
        clientes_id: clientes_id ?? null,
        canal: canalFinal,
        valor_domicilio: domicilio,
        fecha: fechaVenta,
        notas,
        total,
        estado_pago: estadoPago,
        ventas_items: {
          create: items.map((i) => ({
            productos_id: i.productos_id,
            cantidad: i.cantidad,
            precio_unitario: i.precio_unitario,
            subtotal: Number(i.precio_unitario) * i.cantidad,
            costo_unitario: costosPorProducto.get(i.productos_id)?.costo ?? null,
            estado_costo: costosPorProducto.get(i.productos_id)?.estado ?? "sin_costo_verificable",
          })),
        },
      },
      include: { ventas_items: true },
    });

    for (const item of items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { decrement: item.cantidad } },
      });
    }

    // Red de seguridad (crear): un producto repetido en dos líneas no puede dejar el stock en negativo
    await asegurarStockNoNegativo(tx, { productos: items.map((i) => i.productos_id) });

    if (montoAbono > 0) {
      await tx.movimientos_caja.create({
        data: {
          empresas_id: empresasId,
          usuarios_id: usuariosId,
          ventas_id: venta.id,
          tipo: "ingreso",
          categoria: "venta",
          monto: montoAbono,
          descripcion:
            estadoPago !== "pagada"
              ? `Abono inicial venta #${venta.id}`
              : usado > 0
                ? `Venta #${venta.id} (resto con saldo a favor)`
                : `Venta #${venta.id}`,
          fecha: fechaColombiaToUTC(fecha),
        },
      });
    }

    // Saldo a favor: se descuenta del cliente y queda como pago de la venta. No genera
    // ingreso en caja: ese dinero ya entró cuando el cliente lo dejó.
    if (usado > 0) {
      await tx.pagos_venta.create({
        data: { ventas_id: venta.id, usuarios_id: usuariosId, monto: usado, fecha: fechaColombiaToUTC(fecha), nota: "Saldo a favor" },
      });
      await moverSaldo(tx, {
        empresasId,
        clientesId: clientes_id,
        usuariosId,
        ventasId: venta.id,
        tipo: "uso",
        monto: usado,
        nota: `Venta #${venta.id}`,
        fecha: fechaColombiaToUTC(fecha),
      });
    }
    if (montoAbono > 0 && ((esCredito && estadoPago !== "pagada") || usado > 0)) {
      await tx.pagos_venta.create({
        data: {
          ventas_id: venta.id,
          usuarios_id: usuariosId,
          monto: montoAbono,
          fecha: fechaColombiaToUTC(fecha),
          nota: esCredito ? "Abono inicial" : "Pago al registrar",
        },
      });
    }

    // El cliente volvió a comprar: si tenía el aviso de inactividad marcado
    // como enviado, se resetea para que el ciclo de "15 días sin comprar"
    // empiece de nuevo a partir de esta venta.
    if (clientes_id) {
      await tx.clientes.update({
        where: { id: clientes_id },
        data: { aviso_inactivo_enviado: false, aviso_inactivo_enviado_at: null },
      });
    }

    if (pagadoTotal > 0) {
      await registrarRecuperacionVenta(tx, {
        empresasId,
        ventaId: venta.id,
        montoCobrado: pagadoTotal,
        fecha: fechaColombiaToUTC(fecha),
        origen: "venta_inicial",
      });
    }
    return venta;
  });
};

const actualizar = async (id, empresasId, usuariosId, { canal, valor_domicilio, notas, items: itemsEntrada }) => {
  return prisma.$transaction(async (tx) => {
    validarItemsVenta(itemsEntrada);
    validarCanal(canal);
    await tx.$queryRaw`
      SELECT id
      FROM ventas
      WHERE id = ${id}
        AND empresas_id = ${empresasId}
      FOR UPDATE
    `;
    const venta = await tx.ventas.findFirst({
      where: { id, empresas_id: empresasId, anulada: false },
      include: { ventas_items: true, pagos_venta: true },
    });
    if (!venta) throw noEncontrado("Venta no encontrada.");

    const canalFinal = canal ?? venta.canal;
    if ((canalFinal === CONSUMO) !== (venta.canal === CONSUMO))
      throw badRequest("No se puede pasar una venta a o desde consumo propio. Anúlala y regístrala de nuevo.");
    const items = itemsSegunCanal(canalFinal, itemsEntrada);
    const domicilio = resolverDomicilio(canalFinal, valor_domicilio ?? venta.valor_domicilio);
    const nuevoTotal = items.reduce((sum, i) => sum + Number(i.precio_unitario) * i.cantidad, 0) + domicilio;

    // Obtener cuánto dinero se ha recibido realmente.
    // Si existen pagos_venta, son la fuente de verdad porque incluyen
    // tanto efectivo como saldo a favor utilizado.
    let pagado = venta.pagos_venta.reduce((s, p) => s + Number(p.monto), 0);

    // Compatibilidad con ventas históricas que fueron pagadas al registrarse
    // y no generaron filas en pagos_venta.
    let pagosDesdeCaja = [];

    if (venta.pagos_venta.length === 0) {
      const movimientosCaja = await tx.movimientos_caja.findMany({
        where: {
          empresas_id: empresasId,
          ventas_id: id,
          tipo: "ingreso",
          categoria: "venta",
          anulado: false,
        },
        orderBy: [{ fecha: "asc" }, { id: "asc" }],
      });

      pagosDesdeCaja = movimientosCaja.filter((mov) => centavos(mov.monto) > 0);

      pagado = pagosDesdeCaja.reduce((s, mov) => s + Number(mov.monto), 0);

      // Una venta marcada como pagada debe tener un registro que
      // permita comprobar el ingreso, salvo que su total sea cero.
      if (venta.estado_pago !== "pendiente" && centavos(venta.total) > 0 && centavos(pagado) === 0) {
        throw badRequest(
          "No se encontró un ingreso de Caja ni un pago registrado para esta venta. Verifica su historial antes de editarla.",
        );
      }
    }

    // Nunca reducir el total por debajo del dinero que ya recibió la empresa.
    // Una devolución debe registrarse mediante un movimiento explícito.
    if (centavos(pagado) > centavos(nuevoTotal)) {
      throw badRequest(
        `El nuevo total (${nuevoTotal}) es menor a lo ya recibido (${pagado}). Registra primero la devolución correspondiente o anula la venta.`,
      );
    }

    const nuevoEstado = centavos(pagado) >= centavos(nuevoTotal) ? "pagada" : pagado > 0 ? "parcial" : "pendiente";

    // Normalizar pagos históricos: conservar cada ingreso original de Caja
    // como un pago de la venta, sin generar nuevos movimientos de dinero.
    for (const movimiento of pagosDesdeCaja) {
      await tx.pagos_venta.create({
        data: {
          ventas_id: id,
          usuarios_id: movimiento.usuarios_id ?? usuariosId,
          monto: movimiento.monto,
          fecha: movimiento.fecha,
          nota: "Pago histórico de Caja",
        },
      });
    }

    // Revertir stock de items anteriores
    for (const item of venta.ventas_items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { increment: item.cantidad } },
      });
    }

    // Validar stock con nuevos items
    const costosPorProducto = new Map();
    for (const item of items) {
      const producto = await tx.productos.findFirst({
        where: { id: item.productos_id, empresas_id: empresasId, activo: true },
      });
      if (!producto) throw badRequest(`Producto ${item.productos_id} no encontrado.`);
      if (Number(producto.stock_actual) < item.cantidad)
        throw badRequest(`Stock insuficiente para "${producto.nombre}". Disponible: ${producto.stock_actual}.`);
      if (!costosPorProducto.has(item.productos_id))
        costosPorProducto.set(item.productos_id, await resolverCostoPromedioProducto(tx, producto, venta.fecha, venta.created_at));
    }

    // Reemplazar items
    await tx.ventas_items.deleteMany({ where: { ventas_id: id } });
    await tx.ventas_items.createMany({
      data: items.map((i) => ({
        ventas_id: id,
        productos_id: i.productos_id,
        cantidad: i.cantidad,
        precio_unitario: i.precio_unitario,
        subtotal: Number(i.precio_unitario) * i.cantidad,
        costo_unitario: costosPorProducto.get(i.productos_id)?.costo ?? null,
        estado_costo: costosPorProducto.get(i.productos_id)?.estado ?? "sin_costo_verificable",
      })),
    });

    // Descontar stock con nuevos items
    for (const item of items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { decrement: item.cantidad } },
      });
    }

    // Red de seguridad (editar): el stock final de los productos no puede quedar en negativo
    await asegurarStockNoNegativo(tx, { productos: items.map((i) => i.productos_id) });

    const actualizado = await tx.ventas.update({
      where: { id },
      data: { canal: canalFinal, valor_domicilio: domicilio, notas, total: nuevoTotal, estado_pago: nuevoEstado },
    });
    await recalcularRecuperacionesVenta(tx, id);
    return actualizado;
  });
};

const recalcularCostoHistoricoVenta = async (id, empresasId) => {
  return prisma.$transaction(async (tx) => {
    const venta = await tx.ventas.findFirst({
      where: {
        id,
        empresas_id: empresasId,
        anulada: false,
      },
      include: {
        ventas_items: true,
      },
    });

    if (!venta) {
      throw noEncontrado("Venta no encontrada o anulada.");
    }

    if (!venta.ventas_items.length) {
      throw badRequest("La venta no tiene productos para recalcular.");
    }

    const costosPorProducto = new Map();

    for (const item of venta.ventas_items) {
      // Nunca sobrescribir un costo positivo ya registrado.
      if (item.costo_unitario != null && Number(item.costo_unitario) > 0) {
        continue;
      }

      let resultado = costosPorProducto.get(item.productos_id);

      if (!resultado) {
        const producto = await tx.productos.findFirst({
          where: {
            id: item.productos_id,
            empresas_id: empresasId,
          },
        });

        if (!producto) {
          throw badRequest(`No se encontró el producto ${item.productos_id} de la venta.`);
        }

        resultado = await resolverCostoPromedioProducto(tx, producto, venta.fecha, venta.created_at);

        costosPorProducto.set(item.productos_id, resultado);
      }

      await tx.ventas_items.update({
        where: { id: item.id },
        data: {
          costo_unitario: resultado.costo,
          estado_costo: resultado.estado,
        },
      });
    }

    // Actualizar las recuperaciones existentes sin crear movimientos
    // nuevos ni modificar pagos o movimientos de Caja.
    await recalcularRecuperacionesVenta(tx, id);

    return tx.ventas.findFirst({
      where: {
        id,
        empresas_id: empresasId,
      },
      include: {
        ventas_items: true,
      },
    });
  });
};

const anular = async (id, empresasId, usuariosId, motivo) => {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id
      FROM ventas
      WHERE id = ${id}
        AND empresas_id = ${empresasId}
      FOR UPDATE
    `;
    const venta = await tx.ventas.findFirst({
      where: { id, empresas_id: empresasId, anulada: false },
      include: { ventas_items: true },
    });
    if (!venta) throw noEncontrado("Venta no encontrada o ya anulada.");

    // Devolver stock
    for (const item of venta.ventas_items) {
      await tx.productos.update({
        where: { id: item.productos_id },
        data: { stock_actual: { increment: item.cantidad } },
      });
    }

    // Devolver al cliente el saldo a favor que se usó en esta venta
    const usos = await tx.saldos_cliente.findMany({ where: { ventas_id: id, tipo: "uso" } });
    const devolver = usos.reduce((s, u) => s + centavos(u.monto), 0);
    if (devolver > 0 && venta.clientes_id) {
      await moverSaldo(tx, {
        empresasId,
        clientesId: venta.clientes_id,
        usuariosId,
        ventasId: id,
        tipo: "reintegro",
        monto: devolver / 100,
        nota: `Venta #${id} anulada`,
        fecha: new Date(),
      });
    }

    // Anular movimientos de caja vinculados
    await tx.movimientos_caja.updateMany({
      where: { ventas_id: id },
      data: { anulado: true, motivo_anulacion: motivo },
    });

    const anulada = await tx.ventas.update({
      where: { id },
      data: { anulada: true, motivo_anulacion: motivo },
    });
    await tx.fondo_reposicion_movimientos.updateMany({ where: { venta_id: id, anulado: false }, data: { anulado: true } });
    await recalcularFondo(tx, empresasId);
    return anulada;
  });
};

export { listar, obtener, crear, actualizar, recalcularCostoHistoricoVenta, anular };
