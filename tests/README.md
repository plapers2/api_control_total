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
- El comando `npm test` establece `NODE_ENV=test` únicamente para el proceso de pruebas y la API hija; no modifica `.env`.
- La protección de escritura sigue dependiendo de la validación exacta entre `DB_NAME` y `SELECT DATABASE()`, y del sufijo `_prueba` o `_test`.
- Crea una empresa y usuarios temporales con identificadores únicos para cada ejecución.
- Arranca una instancia independiente de la API en un puerto libre; no utiliza ni detiene el servidor habitual del puerto 3000.
- Ejecuta la limpieza de los registros temporales al finalizar, siguiendo las dependencias `RESTRICT` de MariaDB.
- Elimina también el archivo de imagen que haya subido la prueba.

No interrumpas el proceso con Ctrl+C mientras ejecuta la suite, porque eso puede impedir que finalice la limpieza. Si una prueba falla, revisa la salida de limpieza antes de volver a ejecutarla.

## Cobertura

El inventario contiene los 75 endpoints de los módulos y `GET /health`. La prueba final falla si alguno de esos 76 endpoints no se ha ejercitado. Esto comprueba que cada ruta registrada fue llamada al menos una vez; no equivale a probar todas las combinaciones posibles de parámetros, errores y permisos.


## Diagnóstico de pausas (watchdog)

La suite mantiene un watchdog automático mientras prepara los fixtures, ejecuta cada subprueba y limpia los datos temporales. Si una fase permanece sin cambios, escribe `[suite-watchdog]` con:

- la última fase/checkpoint registrado y cuánto tiempo lleva sin avanzar;
- las peticiones HTTP que sigan pendientes, con método, ruta y duración;
- si el proceso de la API aislada continúa activo;
- retraso del event loop, cuando se detecta una pausa de ejecución de Node;
- los últimos registros capturados de la API cuando se supera el umbral de alerta.

Por defecto revisa cada 10 segundos y emite una alerta a partir de 25 segundos sin cambio de fase. Estos valores pueden ajustarse con `SUITE_WATCHDOG_INTERVAL_MS` y `SUITE_WATCHDOG_WARNING_MS`. Las trazas detalladas `[suite-trace]` y `[suite-http]` siguen activándose con `SUITE_TRACE=1`.

Si no hay una petición HTTP pendiente, el watchdog indica que la espera puede estar en Prisma, en otra operación asíncrona o en el runner. El watchdog identifica el último punto conocido, pero no puede asegurar por sí solo la causa raíz de un bloqueo interno; para eso se necesita inspeccionar la consulta o los bloqueos de MariaDB.

## Diagnóstico automático de pausas (watchdog)

La suite vigila automáticamente las fases de ejecución y de limpieza. Si una fase permanece sin cambios, informa el último checkpoint, el tiempo transcurrido, las peticiones HTTP pendientes y las operaciones Prisma directas pendientes (modelo y método). También indica si el servidor hijo sigue activo y detecta retrasos del event loop.

Por defecto revisa cada 10 segundos y genera una alerta a partir de 25 segundos sin cambio de fase. Se ajusta con `SUITE_WATCHDOG_INTERVAL_MS` y `SUITE_WATCHDOG_WARNING_MS`. No necesita configuración adicional. Para ver todas las trazas `[suite-trace]` y `[suite-http]`, establecer `SUITE_TRACE=1`.

El watchdog permite ubicar el punto probable de espera. Si se bloquea dentro de código de la API, un helper Prisma que no esté instrumentado o una operación externa, puede indicar la última fase pero no asegurar por sí solo la causa raíz; se requiere revisar los logs o MariaDB.

## Integridad transaccional

Además de la cobertura de rutas y permisos, la suite verifica tres escenarios transaccionales controlados:

- Dos altas simultáneas del mismo recibo de servicio público, empresa, servicio y periodo: debe persistir una sola y la otra debe responder conflicto HTTP 409.
- Dos abonos simultáneos cuyo importe combinado supera el saldo de una misma venta: debe confirmarse uno solo, manteniendo coherencia entre `pagos_venta`, ingresos de Caja y recuperación vinculada del Fondo.
- Una venta con dos líneas del mismo producto que, en conjunto, exceden el stock: debe rechazarse y revertir encabezado, líneas, stock y cualquier efecto asociado en Caja, pagos y Fondo.

Estos casos comprueban escenarios específicos de concurrencia y rollback; no representan una prueba exhaustiva de todas las intercalaciones concurrentes posibles ni de todos los fallos de infraestructura.

## Integridad de ciclos financieros

La suite también comprueba los ciclos completos de edición y anulación:

- Compra estructurada de insumos: verifica que la edición conserve los IDs de Caja, compra, detalle y movimiento de inventario, actualice cantidades/importes sin duplicar el evento del Fondo y que la anulación restaure el stock y el balance de Caja anteriores, anulando sus registros vinculados.
- Gasto manual: verifica que el balance cambie por el monto registrado, refleje la edición y vuelva al valor anterior después de anularlo, sin crear eventos en el Fondo.
- Venta con saldo a favor y abonos: verifica el consumo de saldo del cliente, la conservación de pagos y movimientos de Caja al editar la venta, y el recálculo de recuperaciones del Fondo con el nuevo total.
- Edición financiera inválida: rechaza reducir el total por debajo del dinero ya recibido y comprueba que no se modifiquen venta, pagos, Caja, Fondo ni stock.
- Anulación de venta: verifica la restauración del inventario, la anulación de ingresos de Caja y recuperaciones del Fondo, la conservación del historial de pagos y el reintegro del saldo a favor usado.
- Devolución del saldo reintegrado: verifica que el saldo del cliente vuelva a cero y que la salida quede reflejada como gasto de Caja.

Estos escenarios operan únicamente sobre la empresa temporal creada por la suite. No alteran registros de otras empresas ni realizan operaciones sobre la base productiva.

## Autoprueba del watchdog (sin base de datos)

Para comprobar deliberadamente las alertas del watchdog sin abrir MariaDB ni arrancar Express, ejecutar:

```powershell
node --test tests/watchdog.selftest.js
```

Esta autoprueba simula una fase pausada con una petición HTTP y una operación Prisma pendientes. Usa intervalos reducidos solo en memoria, captura la salida del watchdog y verifica que reporte la fase, HTTP, Prisma, estado simulado de la API y alerta. No importa el cliente Prisma ni crea fixtures.


## Casos límite de saldos y pagos

La suite cubre también los bordes financieros de clientes y ventas: rechaza depósitos negativos/cero y devoluciones que superan el saldo disponible sin crear movimientos; comprueba que `registrar_en_caja=false` no afecte Caja; evita contar dos veces como ingreso el saldo a favor aplicado a una venta; distribuye abonos generales desde la deuda más antigua; rechaza excedentes no autorizados y registra el excedente autorizado como saldo a favor; verifica la devolución de ese excedente y el efecto de Caja; y prueba abonos individuales parciales, pago exacto del saldo y rechazo de nuevos abonos cuando la venta ya está pagada.

La recuperación histórica verifica el aislamiento por empresa, el enlace de la entrada de inventario existente sin duplicarla ni modificar stock, la idempotencia al repetir la recuperación y el rechazo de registros sin entradas verificables sin crear detalles ni alterar el evento incompleto del Fondo. Todos los registros de estos escenarios pertenecen a fixtures de la empresa temporal y se eliminan al cerrar la suite.
