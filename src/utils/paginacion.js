// Lee page y limit del query string y los deja siempre válidos:
// limit=0 daba "pages: Infinity" y un limit no numérico rompía la consulta.

const LIMITE_MAXIMO = 200;

const entero = (valor, defecto) => {
  const n = Number.parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : defecto;
};

const leerPaginacion = (query = {}, limiteDefecto = 10) => ({
  page: entero(query.page, 1),
  limit: Math.min(entero(query.limit, limiteDefecto), LIMITE_MAXIMO),
});

export { leerPaginacion, LIMITE_MAXIMO };
