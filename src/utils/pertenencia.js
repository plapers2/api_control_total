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

  await db.$queryRaw`
    SELECT id
    FROM clientes
    WHERE id = ${clienteId}
      AND empresas_id = ${empresasId}
    FOR UPDATE
  `;

  const cliente = await db.clientes.findFirst({
    where: { id: clienteId, empresas_id: empresasId },
    select: { id: true, activo: true },
  });

  if (!cliente) throw badRequest("El cliente no existe en tu empresa.");
  if (!cliente.activo) throw badRequest("No puedes registrar una venta a un cliente inactivo.");
};

export { validarProductos, validarInsumos, validarCliente };
