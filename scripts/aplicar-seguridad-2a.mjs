// Uso (desde la raíz del backend): node scripts/aplicar-seguridad-2a.mjs
// Paso 2a (seguridad): aislamiento entre empresas y hashes de contraseña.
// Respeta los saltos de línea de cada archivo (CRLF/LF) y se puede correr
// más de una vez: lo ya aplicado se omite.
import fs from "node:fs";
import path from "node:path";

const raiz = process.cwd();
const SEL = "usuarios: { select: { id: true, nombre: true } }";
const SEL_MIEMBRO = "usuarios: { select: { id: true, nombre: true, email: true, activo: true } }";

const PERTENENCIA = `// Verifica que los ids que llegan en el body pertenezcan a la empresa del
// token. Sin esto, un usuario podía referenciar productos, insumos o clientes
// de OTRA empresa (y modificar su stock o sus avisos).
//
// \`db\` es el cliente de Prisma o la transacción (\`tx\`).

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
`;

// [archivo, [[buscar, reemplazar], ...]]  (siempre con \\n; el script adapta el eol)
const CAMBIOS = [
  [
    "src/modules/ventas/ventas.service.js",
    [
      ['import { noEncontrado } from "../../utils/errors.js";\n',
       'import { noEncontrado } from "../../utils/errors.js";\nimport { validarCliente } from "../../utils/pertenencia.js";\n'],
      ["clientes: true, usuarios: true, ventas_items", `clientes: true, ${SEL}, ventas_items`],
      ["      clientes: true,\n      usuarios: true,\n", `      clientes: true,\n      ${SEL},\n`],
      ["  return prisma.$transaction(async (tx) => {\n    for (const item of items) {\n      const producto = await tx.productos.findFirst({\n        where: { id: item.productos_id, empresas_id: empresasId, activo: true },\n      });\n      if (!producto) throw badRequest(`Producto ${item.productos_id} no encontrado.`);\n      if (Number(producto.stock_actual) < item.cantidad)\n        throw badRequest(`Stock insuficiente para \"${producto.nombre}\". Disponible: ${producto.stock_actual}.`);\n    }\n\n    const total",
       "  return prisma.$transaction(async (tx) => {\n    await validarCliente(tx, empresasId, clientes_id);\n\n    for (const item of items) {\n      const producto = await tx.productos.findFirst({\n        where: { id: item.productos_id, empresas_id: empresasId, activo: true },\n      });\n      if (!producto) throw badRequest(`Producto ${item.productos_id} no encontrado.`);\n      if (Number(producto.stock_actual) < item.cantidad)\n        throw badRequest(`Stock insuficiente para \"${producto.nombre}\". Disponible: ${producto.stock_actual}.`);\n    }\n\n    const total"],
    ],
  ],
  [
    "src/modules/produccion/produccion.service.js",
    [
      ['import { construirRangoFecha } from "../../utils/rangoFecha.js";\n',
       'import { construirRangoFecha } from "../../utils/rangoFecha.js";\nimport { validarProductos, validarInsumos } from "../../utils/pertenencia.js";\n'],
      ["      include: {\n        usuarios: true,\n        lotes_produccion_items: { include: { productos: true } },\n      },",
       `      include: {\n        ${SEL},\n        lotes_produccion_items: { include: { productos: true } },\n      },`],
      ["    include: {\n      usuarios: true,\n      lotes_produccion_items",
       `    include: {\n      ${SEL},\n      lotes_produccion_items`],
      ['  console.log("insumos_reales recibidos:", JSON.stringify(insumos_reales));\n  return prisma.$transaction(async (tx) => {\n',
       "  return prisma.$transaction(async (tx) => {\n    await validarProductos(tx, empresasId, items.map((i) => i.productos_id));\n    await validarInsumos(tx, empresasId, (insumos_reales ?? []).map((i) => i.insumos_id));\n\n"],
      ['    if (!lote) throw new Error("Lote no encontrado.");\n',
       '    if (!lote) throw new Error("Lote no encontrado.");\n\n    await validarProductos(tx, empresasId, items.map((i) => i.productos_id));\n    await validarInsumos(tx, empresasId, (insumos_reales ?? []).map((i) => i.insumos_id));\n'],
    ],
  ],
  [
    "src/modules/caja/caja.service.js",
    [
      ['import { construirRangoFecha } from "../../utils/rangoFecha.js";\n',
       'import { construirRangoFecha } from "../../utils/rangoFecha.js";\nimport { validarInsumos } from "../../utils/pertenencia.js";\n'],
      ["include: { usuarios: true, ventas: true }", `include: { ${SEL}, ventas: true }`],
      ["  if (insumos?.length) {\n    return prisma.$transaction",
       "  if (insumos?.length) {\n    await validarInsumos(prisma, empresasId, insumos.map((i) => i.insumos_id));\n\n    return prisma.$transaction"],
    ],
  ],
  [
    "src/modules/empresas/empresas.service.js",
    [
      ["        include: { usuarios: true, roles: true },\n      },\n    },\n  });",
       `        include: { ${SEL_MIEMBRO}, roles: true },\n      },\n    },\n  });`],
      ["    where: { empresas_id: empresasId },\n    include: { usuarios: true, roles: true },",
       `    where: { empresas_id: empresasId },\n    include: { ${SEL_MIEMBRO}, roles: true },`],
    ],
  ],
  [
    "src/modules/empresas/empresas.routes.js",
    [
      ["const router = Router();\n\nrouter.use(authenticate);\n",
       `const router = Router();

router.use(authenticate);

// Las rutas /empresas/:id/* solo se pueden usar sobre LA empresa del token.
// requireRol("admin") solo mira el rol en la empresa del token, no el :id de la
// URL: sin esta comprobación, un admin de la empresa A podía editar la B o
// agregarse como admin de ella.
const soloMiEmpresa = (req, res, next) => {
  if (!req.empresas_id || Number(req.params.id) !== req.empresas_id) {
    return res.status(403).json({ message: "No puedes administrar otra empresa." });
  }
  next();
};
`],
      ['router.get("/:id", async', 'router.get("/:id", soloMiEmpresa, async'],
      ['router.put("/:id", requireRol("admin")', 'router.put("/:id", soloMiEmpresa, requireRol("admin")'],
      ['router.get("/:id/miembros", requireRol("admin")', 'router.get("/:id/miembros", soloMiEmpresa, requireRol("admin")'],
      ['router.post("/:id/miembros", requireRol("admin")', 'router.post("/:id/miembros", soloMiEmpresa, requireRol("admin")'],
      ['router.delete("/:id/miembros/:userId", requireRol("admin")', 'router.delete("/:id/miembros/:userId", soloMiEmpresa, requireRol("admin")'],
    ],
  ],
];

const destPert = path.join(raiz, "src/utils/pertenencia.js");
if (!fs.existsSync(destPert)) {
  fs.writeFileSync(destPert, PERTENENCIA);
  console.log("creado src/utils/pertenencia.js");
}

let fallos = 0;
for (const [archivo, pares] of CAMBIOS) {
  const ruta = path.join(raiz, archivo);
  const original = fs.readFileSync(ruta, "utf8");
  const crlf = original.includes("\r\n");
  let src = original.replace(/\r\n/g, "\n");
  let aplicados = 0;
  for (const [buscar, nuevo] of pares) {
    if (src.includes(nuevo)) continue; // ya aplicado
    if (src.split(buscar).length !== 2) {
      console.error(`✗ ${archivo}: no encontré (o hay más de una vez) este fragmento:\n  ${buscar.split("\n")[0]}`);
      fallos++;
      continue;
    }
    src = src.replace(buscar, () => nuevo);
    aplicados++;
  }
  if (aplicados) {
    fs.writeFileSync(ruta, crlf ? src.replace(/\n/g, "\r\n") : src);
    console.log(`actualizado ${archivo} (${aplicados} cambios)`);
  }
}
console.log(fallos ? `\nTerminó con ${fallos} fragmento(s) sin aplicar.` : "\nListo.");
process.exitCode = fallos ? 1 : 0;
