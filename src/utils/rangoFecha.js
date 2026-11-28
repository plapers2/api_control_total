import { calcularRangoPeriodo } from "./periodo.js";
import { fechaColombiaToUTC } from "./timezone.js";

const OFFSET_COLOMBIA_MS = 5 * 60 * 60 * 1000;

// En columnas MariaDB DATE, el límite superior debe conservar la etiqueta
// del último día colombiano incluido. No se usa finDiaColombiaToUTC(): su
// 23:59:59.999 Colombia equivale a 04:59:59.999 UTC del día siguiente y el
// adaptador puede normalizarlo como la fecha siguiente, filtrando un día extra.
const finFechaCalendarioColombiaToUTC = (fechaUTC) => {
  const fechaLocal = new Date(fechaUTC.getTime() - OFFSET_COLOMBIA_MS);
  const diaColombia = fechaLocal.toISOString().slice(0, 10);
  return fechaColombiaToUTC(diaColombia);
};

/**
 * Arma el filtro de fecha { gte, lte } a partir de:
 * - desde/hasta explícitos (rango personalizado, tienen prioridad), o
 * - periodo = 'dia' | 'semana' | 'mes' (rango calculado), o
 * - periodo = 'total' | 'todo' → undefined (sin filtro, toda la historia).
 *
 * Se usa en caja, ventas y produccion para que los tres módulos entiendan
 * los mismos filtros que manda el componente FiltroPeriodo del frontend.
 */
const construirRangoFecha = ({ periodo, desde, hasta } = {}) => {
  if (desde && hasta) {
    return { gte: fechaColombiaToUTC(desde), lte: fechaColombiaToUTC(hasta) };
  }
  if (periodo === "total" || periodo === "todo") {
    return undefined;
  }
  const rango = calcularRangoPeriodo(periodo);
  return { gte: rango.desde, lte: finFechaCalendarioColombiaToUTC(rango.hasta) };
};

export { construirRangoFecha };
