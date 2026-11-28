# Diagnóstico automático de pausas de la suite

## Watchdog incorporado

`npm test` inicia automáticamente el watchdog; no necesita `SUITE_TRACE=1` para mostrar avisos de pausa.

- Revisa cada 10 segundos si cambió la fase activa.
- A partir de 25 segundos sin avance, señala la fase exacta registrada y el tiempo transcurrido.
- Muestra cada petición HTTP pendiente con método, ruta, tiempo transcurrido y límite de 15 segundos.
- Instrumenta las llamadas directas del archivo de integración al cliente Prisma e identifica las que siguen pendientes, por ejemplo `prisma.movimientos_caja.count`.
- Informa la última petición HTTP y la última operación Prisma completadas.
- Indica si el proceso de la API aislada sigue activo.
- Si detecta al menos 5 segundos de retraso adicional del event loop, lo informa como posible bloqueo síncrono o carga intensa.
- Vigila también la fase de limpieza.

Los intervalos se pueden personalizar mediante `SUITE_WATCHDOG_INTERVAL_MS` y `SUITE_WATCHDOG_WARNING_MS`.

## Interpretación

- `HTTP pendiente`: la ruta indicada no ha terminado. El cliente HTTP aplica un timeout de 15 segundos; al vencer, la petición falla indicando método, ruta y los últimos logs de la API hija.
- `Prisma pendiente`: se muestra el modelo y método de la consulta invocada directamente desde la suite. Esto acota la espera a esa operación, aunque la causa pueda ser conexión, bloqueo SQL o consulta lenta.
- Sin HTTP ni Prisma pendiente: la espera puede estar en una operación dentro del proceso de la API, en un helper no instrumentado o en el runner.
- Retraso del event loop: Node no pudo ejecutar el watchdog a tiempo, señal compatible con una operación síncrona larga o carga intensa.

El watchdog informa dónde se detuvo el progreso y qué operación estaba pendiente; no puede identificar automáticamente la causa raíz de todos los bloqueos de MariaDB. Para eso se debe revisar el estado de transacciones/bloqueos y los logs del proceso.

## Trazas detalladas

Para ver todos los checkpoints y el inicio/fin de cada petición HTTP:

```powershell
$traceAnterior = $env:SUITE_TRACE
try {
    $env:SUITE_TRACE = "1"
    npm test
    $codigo = $LASTEXITCODE
}
finally {
    if ($null -eq $traceAnterior) {
        Remove-Item Env:SUITE_TRACE -ErrorAction SilentlyContinue
    }
    else {
        $env:SUITE_TRACE = $traceAnterior
    }
}
Write-Output "Código de salida: $codigo"
```

Si una ejecución se interrumpe externamente con `Ctrl+C` o se termina Node desde Windows, la limpieza automática puede no ejecutarse. Verificar por `runId` los registros temporales antes de repetir el test.

## Verificación artificial del watchdog sin BD

Ejecutar `node --test tests/watchdog.selftest.js`. Esta autoprueba importa únicamente `tests/helpers/watchdog.js`, simula una fase inmóvil y verifica la salida diagnóstica. No carga `src/db/prisma.js`, no abre conexiones y no crea ni elimina datos.
