/**
 * Utilidades de zona horaria — Colombia (UTC-5), sin horario de verano.
 *
 * PROBLEMA QUE RESUELVE:
 * El frontend manda fechas como string 'YYYY-MM-DD' (hora local de Colombia).
 * Si el backend hace `new Date('2026-06-19')`, JavaScript lo interpreta como
 * medianoche UTC, NO medianoche Colombia. Como Colombia es UTC-5, eso equivale
 * a las 7:00pm del día anterior en hora local — y como las columnas son
 * @db.Date, el registro queda guardado un día antes del que realmente es.
 *
 * Esta función ancla el string a medianoche Colombia de forma explícita,
 * sin depender de la zona horaria configurada en el sistema operativo del
 * servidor (que no podemos garantizar, sobre todo en hosting compartido).
 */

const OFFSET_COLOMBIA_HORAS = 5; // Colombia es UTC-5 todo el año (sin DST)

/**
 * Convierte un string 'YYYY-MM-DD' (fecha local de Colombia) a un objeto
 * Date que representa correctamente esa medianoche en Colombia, expresado
 * en UTC internamente (como todo Date en JS).
 *
 * 'YYYY-MM-DD'  →  Date  (medianoche Colombia = 05:00 UTC ese mismo día)
 */
const fechaColombiaToUTC = (fechaString) => {
  if (!fechaString) return new Date();

  // Soporta tanto 'YYYY-MM-DD' como un Date/ISO ya completo (defensivo)
  const soloFecha = String(fechaString).slice(0, 10);
  const [y, m, d] = soloFecha.split("-").map(Number);

  if (!y || !m || !d) return new Date(fechaString);

  // Date.UTC con la hora de Colombia sumada da el instante UTC correcto
  return new Date(Date.UTC(y, m - 1, d, OFFSET_COLOMBIA_HORAS, 0, 0, 0));
};

/**
 * Igual que fechaColombiaToUTC, pero ancla al final del día Colombia
 * (23:59:59.999 Colombia). Útil como límite "hasta" de un rango de fechas,
 * para que el día final quede incluido por completo.
 *
 * 'YYYY-MM-DD'  →  Date  (23:59:59.999 Colombia = 04:59:59.999 UTC del día siguiente)
 */
const finDiaColombiaToUTC = (fechaString) => {
  if (!fechaString) return new Date();

  const soloFecha = String(fechaString).slice(0, 10);
  const [y, m, d] = soloFecha.split("-").map(Number);

  if (!y || !m || !d) return new Date(fechaString);

  return new Date(Date.UTC(y, m - 1, d, OFFSET_COLOMBIA_HORAS + 23, 59, 59, 999));
};

export { fechaColombiaToUTC, finDiaColombiaToUTC };
