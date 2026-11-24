// Verifica que los ids que llegan en el body pertenezcan a la empresa del
// token. Sin esto, un usuario podía referenciar productos, insumos o clientes
// de OTRA empresa (y modificar su stock o sus avisos).
//
// `db` es el cliente de Prisma o la transacción (`tx`).

const badRequest = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });

const idsUnicos = (ids) => {
  const lista = [...new Set((ids ?? []).filter((id) => id != null).map(Number))];
  if (lista.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw badRequest("Hay identificadores inválidos en la solicitud.");
  }
  return lista;
};

const validarProductos = async (db, empresasId, ids) => {
  const lista = idsUnicos(ids);
  if (!lista.length) return;
  const n = await db.productos.count({ where: { id: { in: lista }, empresas_id: empresasId } });
  if (n !== lista.length) throw badRequest("Uno o más productos no existen en tu empresa.");
};

const validarInsumos = async (db, empresasId, ids) => {
  const lista = idsUnicos(ids);
  if (!lista.length) return;
  const n = await db.insumos.count({ where: { id: { in: lista }, empresas_id: empresasId } });
  if (n !== lista.length) throw badRequest("Uno o más insumos no existen en tu empresa.");
};

const validarCliente = async (db, empresasId, id) => {
  if (id == null) return;
  const [clienteId] = idsUnicos([id]);
  const n = await db.clientes.count({ where: { id: clienteId, empresas_id: empresasId } });
  if (!n) throw badRequest("El cliente no existe en tu empresa.");
};

export { validarProductos, validarInsumos, validarCliente };
