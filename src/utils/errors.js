const noEncontrado = (mensaje = "Recurso no encontrado.") => {
  const error = new Error(mensaje);
  error.status = 404;
  return error;
};

export { noEncontrado };
