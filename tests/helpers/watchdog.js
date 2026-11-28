/**
 * Watchdog independiente de la API y de Prisma.
 * Recibe el diagnóstico de la suite mediante callbacks para que su
 * comportamiento pueda probarse con datos simulados, sin tocar MariaDB.
 */
export function iniciarWatchdogSuite({
  obtenerDiagnosticoSuite,
  obtenerEntorno = () => null,
  intervalMs: intervalOverride,
  warningMs: warningOverride,
  escribir = (mensaje) => process.stderr.write(mensaje),
} = {}) {
  if (typeof obtenerDiagnosticoSuite !== "function") {
    throw new TypeError("iniciarWatchdogSuite requiere obtenerDiagnosticoSuite().");
  }

  const intervalConfigurado = Number(process.env.SUITE_WATCHDOG_INTERVAL_MS);
  const warningConfigurado = Number(process.env.SUITE_WATCHDOG_WARNING_MS);
  const intervalMs = Number.isFinite(intervalOverride) && intervalOverride > 0
    ? intervalOverride
    : intervalConfigurado > 0 ? intervalConfigurado : 10_000;
  const warningMs = Number.isFinite(warningOverride) && warningOverride > 0
    ? warningOverride
    : warningConfigurado > 0 ? warningConfigurado : 25_000;

  let expectedTick = Date.now() + intervalMs;
  let ultimaAlerta = "";

  const timer = setInterval(() => {
    const now = Date.now();
    const retrasoEventLoopMs = Math.max(0, now - expectedTick);
    expectedTick = now + intervalMs;

    const estado = obtenerDiagnosticoSuite();
    const fase = estado.fase?.nombre ?? "Fase no registrada";
    const sinAvanceMs = estado.fase?.iniciadaEn
      ? now - estado.fase.iniciadaEn
      : 0;

    // No llena la consola cuando todo avanza normalmente: informa solo si
    // la fase actual lleva al menos un intervalo sin registrar progreso.
    if (sinAvanceMs < intervalMs) return;

    const activos = estado.peticionesActivas ?? [];
    const entorno = obtenerEntorno();
    const procesoApi = entorno?.server?.child;
    const estadoApi = !procesoApi
      ? "API de pruebas aún no disponible"
      : procesoApi.exitCode !== null
        ? `API de pruebas finalizó con código ${procesoApi.exitCode}`
        : procesoApi.signalCode
          ? `API de pruebas terminó por señal ${procesoApi.signalCode}`
          : `API de pruebas activa en ${entorno.server.baseUrl}`;

    const operacionesPrisma = estado.operacionesPrismaActivas ?? [];
    const ultimaHttp = estado.ultimaPeticionHttp;
    const ultimaPrisma = estado.ultimaOperacionPrisma;
    const diagnosticoHttp = activos.length
      ? `HTTP pendiente: ${activos.map((item) => `${item.method} ${item.path} (${((now - item.iniciadaEn) / 1000).toFixed(1)} s; límite ${item.timeoutMs} ms)`).join("; ")}. `
      : `Sin HTTP pendiente${ultimaHttp ? `; última petición: ${ultimaHttp.method} ${ultimaHttp.path} ${ultimaHttp.resultado} (${ultimaHttp.duracionMs} ms)` : ""}. `;
    const diagnosticoPrisma = operacionesPrisma.length
      ? `Prisma pendiente: ${operacionesPrisma.map((item) => `${item.nombre} (${(item.duracionMs / 1000).toFixed(1)} s)`).join("; ")}. `
      : `Sin operación Prisma pendiente${ultimaPrisma ? `; última operación: ${ultimaPrisma.nombre} ${ultimaPrisma.resultado} (${ultimaPrisma.duracionMs} ms)` : ""}. `;

    escribir(
      `[suite-watchdog] SIN AVANCE durante ${(sinAvanceMs / 1000).toFixed(0)} s. ` +
      `Última fase: ${fase}. ` +
      diagnosticoHttp +
      diagnosticoPrisma +
      `${estadoApi}.` +
      (retrasoEventLoopMs >= 5_000
        ? ` Retraso del event loop detectado: ${(retrasoEventLoopMs / 1000).toFixed(1)} s.`
        : "") +
      "\n",
    );

    if (sinAvanceMs >= warningMs) {
      const claveAlerta = `${fase}:${estado.fase?.iniciadaEn ?? ""}`;
      if (ultimaAlerta !== claveAlerta) {
        ultimaAlerta = claveAlerta;
        escribir(
          `[suite-watchdog] ALERTA: la suite superó ${(warningMs / 1000).toFixed(0)} s sin cambiar de fase. ` +
          "No se puede afirmar la causa raíz solo con el test; la última fase y las peticiones pendientes anteriores indican dónde investigar.\n",
        );
        const logsApi = entorno?.server?.getOutput?.() ?? "";
        if (logsApi) {
          escribir(`[suite-watchdog] Última salida de la API de pruebas:\n${logsApi.slice(-4000)}\n`);
        }
      }
    } else {
      ultimaAlerta = "";
    }
  }, intervalMs);

  // El watchdog no debe mantener vivo el proceso si la suite ya terminó.
  timer.unref();
  return () => clearInterval(timer);
}
