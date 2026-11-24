// Valida números opcionales que no pueden ser negativos (stock, precios).
// Acepta undefined/null/"" (campo no enviado) y números o strings numéricos >= 0.
const noNegativo = (v) => v === undefined || v === null || v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0);

export { noNegativo };
