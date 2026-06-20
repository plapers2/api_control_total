/**
 * Calcula el rango de fechas [desde, hasta] según el periodo solicitado,
 * usando el día calendario de Colombia (UTC-5), sin depender de la zona
 * horaria del servidor donde corre Node.
 *
 * periodo: 'dia' | 'semana' | 'mes'
 * Si no se reconoce el periodo, por defecto se usa 'dia'.
 */

const OFFSET_COLOMBIA_HORAS = 5; // Colombia es UTC-5 todo el año (sin DST)

const calcularRangoPeriodo = (periodo) => {
  // Tomamos el instante actual y lo "movemos" 5 horas atrás para poder
  // leer año/mes/día/día-de-semana como si fueran en hora Colombia,
  // usando los getters UTC (que no dependen de la timezone del servidor).
  const ahoraUTC = new Date();
  const hoyColombia = new Date(ahoraUTC.getTime() - OFFSET_COLOMBIA_HORAS * 60 * 60 * 1000);

  const y = hoyColombia.getUTCFullYear();
  const m = hoyColombia.getUTCMonth();
  const d = hoyColombia.getUTCDate();

  // Helper: dado un día del mes (puede salirse de rango, ej. 32 o 0),
  // arma el instante UTC que corresponde a las 00:00:00.000 Colombia
  // de ese día. Date.UTC normaliza automáticamente overflow de mes/año.
  const inicioDiaColombia = (anio, mes, dia) => new Date(Date.UTC(anio, mes, dia, OFFSET_COLOMBIA_HORAS, 0, 0, 0));

  // Igual pero para las 23:59:59.999 Colombia de ese día (= hora 28:59:59.999
  // en UTC con offset, que Date.UTC normaliza al día siguiente automáticamente).
  const finDiaColombia = (anio, mes, dia) => new Date(Date.UTC(anio, mes, dia, OFFSET_COLOMBIA_HORAS + 23, 59, 59, 999));

  let desde;
  let hasta;

  if (periodo === "semana") {
    // Lunes de esta semana como inicio, domingo como fin (en hora Colombia).
    const diaSemana = hoyColombia.getUTCDay(); // 0 = domingo, 1 = lunes, ... 6 = sábado
    const diffLunes = diaSemana === 0 ? -6 : 1 - diaSemana;
    desde = inicioDiaColombia(y, m, d + diffLunes);
    hasta = finDiaColombia(y, m, d + diffLunes + 6);
  } else if (periodo === "mes") {
    desde = inicioDiaColombia(y, m, 1);
    hasta = finDiaColombia(y, m + 1, 0); // día 0 del mes siguiente = último día del mes actual
  } else {
    // 'dia' (default)
    desde = inicioDiaColombia(y, m, d);
    hasta = finDiaColombia(y, m, d);
  }

  return { desde, hasta };
};

export { calcularRangoPeriodo };
