import { calcularRangoPeriodo } from "./periodo.js";
import { fechaColombiaToUTC, finDiaColombiaToUTC } from "./timezone.js";

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
    return { gte: fechaColombiaToUTC(desde), lte: finDiaColombiaToUTC(hasta) };
  }
  if (periodo === "total" || periodo === "todo") {
    return undefined;
  }
  const rango = calcularRangoPeriodo(periodo);
  return { gte: rango.desde, lte: rango.hasta };
};

export { construirRangoFecha };
