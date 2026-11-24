// Red de seguridad contra stock negativo y cantidades inválidas.

const badRequest = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });

const unicos = (ids) => [...new Set((ids ?? []).filter((id) => id != null).map(Number))];

// Se llama dentro de una transacción, DESPUÉS de aplicar los descuentos. Si
// algún producto o insumo quedó por debajo de 0 lanza un 400 y Prisma revierte
// toda la transacción. Como el UPDATE bloquea la fila y la lectura es de la
// misma transacción, también atrapa dos operaciones simultáneas que juntas
// dejarían el stock en negativo, o un mismo producto repetido en dos líneas.
const asegurarStockNoNegativo = async (tx, { productos = [], insumos = [] } = {}, { mensajeProducto, mensajeInsumo } = {}) => {
  const pIds = unicos(productos);
  if (pIds.length) {
    const p = await tx.productos.findFirst({ where: { id: { in: pIds }, stock_actual: { lt: 0 } } });
    if (p) throw badRequest(mensajeProducto ? mensajeProducto(p) : 'Stock insuficiente para "' + p.nombre + '".');
  }

  const iIds = unicos(insumos);
  if (iIds.length) {
    const i = await tx.insumos.findFirst({ where: { id: { in: iIds }, stock_actual: { lt: 0 } } });
    if (i) throw badRequest(mensajeInsumo ? mensajeInsumo(i) : 'Insumo insuficiente: "' + i.nombre + '".');
  }
};

// Ventas: cantidad entera > 0 y precio >= 0. Una cantidad negativa pasaba la
// validación de stock y en realidad SUMABA stock.
const validarItemsVenta = (items) => {
  for (const i of items) {
    const cantidad = Number(i.cantidad);
    const precio = Number(i.precio_unitario);
    if (!Number.isInteger(cantidad) || cantidad <= 0) throw badRequest("Las cantidades deben ser números enteros mayores a 0.");
    if (!Number.isFinite(precio) || precio < 0) throw badRequest("El precio de cada producto debe ser un número válido, no negativo.");
  }
};

// Producción: cantidad entera > 0 por producto.
const validarCantidadesEnteras = (items) => {
  for (const i of items) {
    const cantidad = Number(i.cantidad);
    if (!Number.isInteger(cantidad) || cantidad <= 0) throw badRequest("Las cantidades deben ser números enteros mayores a 0.");
  }
};

export { asegurarStockNoNegativo, validarItemsVenta, validarCantidadesEnteras };
