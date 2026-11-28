# Suite de integración de Control Total

## Ejecución

Desde la carpeta raíz del backend, con el archivo `.env` ya configurado y las dependencias instaladas, ejecutar:

```powershell
npm test
```

La suite usa `node:test` y `fetch` nativos de Node. Requiere una versión de Node que admita `--env-file` (Node 20.6 o posterior). El cliente Prisma generado debe estar disponible; normalmente lo genera `npm install` mediante `postinstall` o `npm run build`.

## Protecciones

- Carga las variables desde `.env`; no contiene nombres de bases de datos ni credenciales fijas.
- Antes de crear datos, compara `DB_NAME` con `SELECT DATABASE()` y exige que el nombre termine en `_prueba` o `_test`.
- Se niega a ejecutarse cuando `NODE_ENV=production`.
- Crea una empresa y usuarios temporales con identificadores únicos para cada ejecución.
- Arranca una instancia independiente de la API en un puerto libre; no utiliza ni detiene el servidor habitual del puerto 3000.
- Ejecuta la limpieza de los registros temporales al finalizar, siguiendo las dependencias `RESTRICT` de MariaDB.
- Elimina también el archivo de imagen que haya subido la prueba.

No interrumpas el proceso con Ctrl+C mientras ejecuta la suite, porque eso puede impedir que finalice la limpieza. Si una prueba falla, revisa la salida de limpieza antes de volver a ejecutarla.

## Cobertura

El inventario contiene los 75 endpoints de los módulos y `GET /health`. La prueba final falla si alguno de esos 76 endpoints no se ha ejercitado. Esto comprueba que cada ruta registrada fue llamada al menos una vez; no equivale a probar todas las combinaciones posibles de parámetros, errores y permisos.

## Pruebas negativas y de seguridad

La suite también comprueba respuestas de rechazo y ausencia de efectos secundarios en escenarios seleccionados:

- Token ausente o inválido, empresa no seleccionada y usuario con cambio obligatorio de contraseña pendiente.
- Rol de empleado al intentar crear o modificar productos, ajustar inventario, reconstruir el Fondo o editar/anular ventas.
- Acceso desde una empresa a productos, insumos y clientes de otra empresa.
- Referencias cruzadas entre empresas en recetas, compras de insumos, producción y ventas.
- Datos inválidos, como precio o monto negativo, ajuste de stock negativo, compra de insumos sin detalle y venta sin artículos.
- Verificación de que los rechazos no creen registros ni modifiquen los saldos, existencias, movimientos de inventario o Fondo comprobados.

Estos casos son una selección de controles críticos, no una matriz exhaustiva de todos los campos y roles de los 76 endpoints. Cada nueva regla de negocio o permiso debe tener sus propios casos específicos.
