import prisma from "../../db/prisma.js";

// Fecha del registro más antiguo (sin contar los anulados) de la empresa.
// Con "modulo" (ventas, caja o produccion) mira solo ese módulo; sin él, o con
// un valor desconocido, toma el más antiguo de los tres. Devuelve
// { fecha: "YYYY-MM-DD" } o { fecha: null } si todavía no hay registros.
const FUENTES = {
  ventas: (empresasId) => prisma.ventas.aggregate({ where: { empresas_id: empresasId, anulada: false }, _min: { fecha: true } }),
  caja: (empresasId) => prisma.movimientos_caja.aggregate({ where: { empresas_id: empresasId, anulado: false }, _min: { fecha: true } }),
  produccion: (empresasId) =>
    prisma.lotes_produccion.aggregate({ where: { empresas_id: empresasId, anulado: false }, _min: { fecha: true } }),
};

export const primerRegistro = async (empresasId, modulo) => {
  const fuentes = FUENTES[modulo] ? [FUENTES[modulo]] : Object.values(FUENTES);
  const resultados = await Promise.all(fuentes.map((consultar) => consultar(empresasId)));

  const fechas = resultados
    .map((r) => r._min.fecha)
    .filter(Boolean)
    .map((d) => d.toISOString().slice(0, 10))
    .sort();

  return { fecha: fechas[0] ?? null };
};
