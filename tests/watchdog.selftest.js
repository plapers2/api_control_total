import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { iniciarWatchdogSuite } from "./helpers/watchdog.js";

test("watchdog informa una pausa artificial sin conectar con MariaDB ni iniciar la API", async () => {
  const ahora = Date.now();
  let salida = "";
  let lecturasEntorno = 0;

  const detener = iniciarWatchdogSuite({
    intervalMs: 20,
    warningMs: 45,
    obtenerDiagnosticoSuite: () => ({
      fase: {
        nombre: "SELF-TEST: pausa artificial antes de registrar un recibo",
        iniciadaEn: ahora - 1_000,
      },
      peticionesActivas: [{
        id: 1,
        method: "POST",
        path: "/api/caja",
        iniciadaEn: ahora - 900,
        timeoutMs: 15_000,
      }],
      ultimaPeticionHttp: null,
      operacionesPrismaActivas: [{
        id: 1,
        nombre: "prisma.movimientos_caja.count",
        iniciadaEn: ahora - 850,
        duracionMs: Date.now() - (ahora - 850),
      }],
      ultimaOperacionPrisma: null,
    }),
    obtenerEntorno: () => {
      lecturasEntorno += 1;
      return {
        server: {
          child: { exitCode: null, signalCode: null },
          baseUrl: "http://127.0.0.1:59999",
          getOutput: () => "[self-test] salida simulada del servidor",
        },
      };
    },
    escribir: (mensaje) => { salida += mensaje; },
  });

  try {
    // Pausa intencional: simula una fase que deja de avanzar.
    // No existe cliente Prisma, servidor Express ni conexión a BD en este archivo.
    await delay(110);
  } finally {
    detener();
  }

  assert.match(salida, /SIN AVANCE/);
  assert.match(salida, /SELF-TEST: pausa artificial antes de registrar un recibo/);
  assert.match(salida, /HTTP pendiente: POST \/api\/caja/);
  assert.match(salida, /Prisma pendiente: prisma\.movimientos_caja\.count/);
  assert.match(salida, /API de pruebas activa en http:\/\/127\.0\.0\.1:59999/);
  assert.match(salida, /ALERTA: la suite superó/);
  assert.match(salida, /salida simulada del servidor/);
  assert.ok(lecturasEntorno > 0, "El watchdog debe consultar el estado simulado de la API.");
});
