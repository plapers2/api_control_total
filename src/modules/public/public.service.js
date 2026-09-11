import prisma from "../../db/prisma.js";

/**
 * Resuelve qué empresa se muestra en la página pública.
 *
 * Este proyecto es de una sola empresa. Se usa PUBLIC_EMPRESA_ID si está
 * definida en el .env; si no, se toma la primera empresa activa (funciona
 * sin configuración adicional mientras solo haya una empresa en la base
 * de datos).
 */
const resolverEmpresaPublica = async () => {
  const idConfigurado = Number(process.env.PUBLIC_EMPRESA_ID);
  if (idConfigurado) {
    return prisma.empresas.findFirst({ where: { id: idConfigurado, activa: true } });
  }
  return prisma.empresas.findFirst({ where: { activa: true }, orderBy: { id: "asc" } });
};

const obtenerEmpresa = async () => {
  const empresa = await resolverEmpresaPublica();
  if (!empresa) return null;
  return { id: empresa.id, nombre: empresa.nombre, descripcion: empresa.descripcion };
};

const listarProductos = async () => {
  const empresa = await resolverEmpresaPublica();
  if (!empresa) return [];

  return prisma.productos.findMany({
    where: { empresas_id: empresa.id, activo: true },
    orderBy: { nombre: "asc" },
    select: { id: true, nombre: true, descripcion: true, precio_venta: true, imagen_url: true },
  });
};

export { obtenerEmpresa, listarProductos };
