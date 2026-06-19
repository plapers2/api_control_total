/**
 * Calcula el rango de fechas [desde, hasta] según el periodo solicitado.
 * Las fechas se devuelven como objetos Date listos para usar en Prisma
 * (gte/lte), usando el inicio y fin del periodo en el día calendario.
 *
 * periodo: 'dia' | 'semana' | 'mes'
 * Si no se reconoce el periodo, por defecto se usa 'dia'.
 */
const calcularRangoPeriodo = (periodo) => {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = hoy.getMonth();
  const d = hoy.getDate();

  let desde;
  let hasta;

  if (periodo === "semana") {
    // Lunes de esta semana como inicio, domingo como fin.
    const diaSemana = hoy.getDay(); // 0 = domingo, 1 = lunes, ... 6 = sábado
    const diffLunes = diaSemana === 0 ? -6 : 1 - diaSemana;
    desde = new Date(y, m, d + diffLunes);
    hasta = new Date(y, m, d + diffLunes + 6);
  } else if (periodo === "mes") {
    desde = new Date(y, m, 1);
    hasta = new Date(y, m + 1, 0); // día 0 del mes siguiente = último día del mes actual
  } else {
    // 'dia' (default)
    desde = new Date(y, m, d);
    hasta = new Date(y, m, d);
  }

  // Normalizar horas: desde a las 00:00:00.000, hasta a las 23:59:59.999
  desde.setHours(0, 0, 0, 0);
  hasta.setHours(23, 59, 59, 999);

  return { desde, hasta };
};

export { calcularRangoPeriodo };
