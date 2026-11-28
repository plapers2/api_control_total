import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../../src/db/prisma.js";

export const FECHA_COLOMBIA = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bogota",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

export const PERIODO_COLOMBIA = FECHA_COLOMBIA.slice(0, 7);


let faseActivaSuite = {
  nombre: "Inicializando suite",
  iniciadaEn: Date.now(),
};
const peticionesHttpActivas = new Map();
let ultimaPeticionHttp = null;
let secuenciaPeticionHttp = 0;
const operacionesPrismaActivas = new Map();
let ultimaOperacionPrisma = null;
let secuenciaOperacionPrisma = 0;

export function registrarFaseSuite(nombre) {
  faseActivaSuite = {
    nombre: String(nombre),
    iniciadaEn: Date.now(),
  };
}

export function obtenerDiagnosticoSuite() {
  const ahora = Date.now();
  return {
    fase: { ...faseActivaSuite },
    peticionesActivas: [...peticionesHttpActivas.values()].map((peticion) => ({
      ...peticion,
      duracionMs: ahora - peticion.iniciadaEn,
    })),
    ultimaPeticionHttp: ultimaPeticionHttp ? { ...ultimaPeticionHttp } : null,
    operacionesPrismaActivas: [...operacionesPrismaActivas.values()].map((operacion) => ({
      ...operacion,
      duracionMs: ahora - operacion.iniciadaEn,
    })),
    ultimaOperacionPrisma: ultimaOperacionPrisma ? { ...ultimaOperacionPrisma } : null,
  };
}

const METODOS_PRISMA_OBSERVADOS = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow",
  "findMany", "count", "aggregate", "groupBy",
  "create", "createMany", "update", "updateMany", "upsert",
  "delete", "deleteMany",
]);

/**
 * Envuelve los delegados Prisma usados directamente por la suite para que el
 * watchdog pueda identificar el modelo y método que sigue pendiente.
 * No cambia argumentos, filtros ni resultados de las consultas.
 */
export function instrumentarPrismaParaSuite(cliente) {
  const proxiesDelegados = new WeakMap();

  return new Proxy(cliente, {
    get(target, propiedad) {
      const delegado = Reflect.get(target, propiedad, target);

      if (
        typeof propiedad === "string" &&
        !propiedad.startsWith("$") &&
        delegado &&
        typeof delegado === "object"
      ) {
        if (!proxiesDelegados.has(delegado)) {
          const proxyDelegado = new Proxy(delegado, {
            get(modelo, metodo) {
              const operacion = Reflect.get(modelo, metodo, modelo);
              if (typeof operacion !== "function") return operacion;
              if (!METODOS_PRISMA_OBSERVADOS.has(String(metodo))) return operacion.bind(modelo);

              return (...args) => {
                const id = ++secuenciaOperacionPrisma;
                const iniciadaEn = Date.now();
                const nombre = `prisma.${String(propiedad)}.${String(metodo)}`;
                operacionesPrismaActivas.set(id, { id, nombre, iniciadaEn });

                let resultado;
                try {
                  resultado = operacion.apply(modelo, args);
                } catch (error) {
                  operacionesPrismaActivas.delete(id);
                  ultimaOperacionPrisma = {
                    nombre,
                    resultado: `ERROR ${error.message}`,
                    duracionMs: Date.now() - iniciadaEn,
                    finalizadaEn: Date.now(),
                  };
                  throw error;
                }

                return Promise.resolve(resultado).then(
                  (valor) => {
                    ultimaOperacionPrisma = {
                      nombre,
                      resultado: "completada",
                      duracionMs: Date.now() - iniciadaEn,
                      finalizadaEn: Date.now(),
                    };
                    return valor;
                  },
                  (error) => {
                    ultimaOperacionPrisma = {
                      nombre,
                      resultado: `ERROR ${error.message}`,
                      duracionMs: Date.now() - iniciadaEn,
                      finalizadaEn: Date.now(),
                    };
                    throw error;
                  },
                ).finally(() => operacionesPrismaActivas.delete(id));
              };
            },
          });
          proxiesDelegados.set(delegado, proxyDelegado);
        }
        return proxiesDelegados.get(delegado);
      }

      return typeof delegado === "function" ? delegado.bind(target) : delegado;
    },
  });
}

export const EXPECTED_ENDPOINTS = [
  "POST /api/auth/login",
  "POST /api/auth/select-empresa",
  "GET /api/auth/me",
  "GET /api/auth/usuarios",
  "POST /api/auth/usuarios",
  "DELETE /api/auth/usuarios/:id",
  "POST /api/auth/cambiar-password",

  "GET /api/caja/fondo-resumen",
  "POST /api/caja/fondo-reconstruir",
  "POST /api/caja/compras-historicas/:id/recuperar",
  "GET /api/caja",
  "GET /api/caja/resumen",
  "GET /api/caja/disponible-resumen",
  "POST /api/caja",
  "PUT /api/caja/:id",
  "DELETE /api/caja/:id",

  "GET /api/clientes",
  "GET /api/clientes/inactivos",
  "GET /api/clientes/:id",
  "POST /api/clientes",
  "PUT /api/clientes/:id",
  "DELETE /api/clientes/:id",
  "PATCH /api/clientes/:id/aviso",
  "GET /api/clientes/:id/saldo",
  "POST /api/clientes/:id/saldo",
  "POST /api/clientes/:id/saldo/devolucion",

  "GET /api/deudas",
  "GET /api/deudas/resumen",
  "POST /api/deudas/:ventaId/pagos",
  "GET /api/deudas/clientes",
  "GET /api/deudas/clientes/:clientesId",
  "POST /api/deudas/clientes/:clientesId/pagos",

  "GET /api/empresas",
  "GET /api/empresas/:id",
  "PUT /api/empresas/:id",
  "GET /api/empresas/:id/miembros",
  "POST /api/empresas/:id/miembros",
  "DELETE /api/empresas/:id/miembros/:userId",

  "GET /api/insumos",
  "POST /api/insumos/:id/ajuste",
  "POST /api/insumos/:id/conciliacion",
  "GET /api/insumos/:id/conciliaciones",
  "GET /api/insumos/:id",
  "POST /api/insumos",
  "PUT /api/insumos/:id",
  "DELETE /api/insumos/:id",

  "GET /api/produccion",
  "GET /api/produccion/:id",
  "POST /api/produccion",
  "PUT /api/produccion/:id",
  "DELETE /api/produccion/:id",

  "GET /api/productos",
  "GET /api/productos/:id",
  "GET /api/productos/:id/historial",
  "POST /api/productos",
  "PUT /api/productos/:id",
  "DELETE /api/productos/:id",
  "PUT /api/productos/:id/receta",
  "POST /api/productos/:id/imagen",

  "GET /api/public/empresa",
  "GET /api/public/productos",

  "GET /api/reportes/rentabilidad",
  "GET /api/reportes/primer-registro",

  "GET /api/servicios-publicos",
  "PUT /api/servicios-publicos/configuracion",

  "GET /api/superadmin/empresas",
  "POST /api/superadmin/empresas",
  "GET /api/superadmin/usuarios",
  "POST /api/superadmin/usuarios/:id/password-temporal",

  "GET /api/ventas",
  "GET /api/ventas/:id",
  "POST /api/ventas",
  "POST /api/ventas/:id/recalcular-costo-historico",
  "PUT /api/ventas/:id",
  "DELETE /api/ventas/:id",
  "GET /health",
];

export function assertHttp(response, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert.ok(
    allowed.includes(response.status),
    `${label}: HTTP ${response.status}; esperado ${allowed.join(" o ")}. Respuesta: ${JSON.stringify(response.json)}`,
  );
}

async function obtenerPuertoLibre() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function iniciarServidor(empresasId) {
  const port = await obtenerPuertoLibre();
  const child = spawn(process.execPath, ["app.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_EMPRESA_ID: String(empresasId),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let output = "";
  let spawnError = null;
  child.on("error", (error) => { spawnError = error; });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25_000;

  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`No se pudo iniciar el proceso de la API de pruebas: ${spawnError.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`La API de pruebas terminó antes de iniciar. Salida:\n${output.slice(-5000)}`);
    }

    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const data = await response.json();
        if (data?.status === "ok") return { child, baseUrl, getOutput: () => output };
      }
    } catch {
      // El servidor aún está abriendo el puerto.
    }

    await delay(200);
  }

  await detenerServidor({ child });
  throw new Error(`Tiempo agotado esperando el servidor de pruebas. Salida:\n${output.slice(-5000)}`);
}

export async function detenerServidor(server) {
  if (!server?.child) return;
  const child = server.child;
  if (child.exitCode !== null || child.signalCode !== null) return;

  const esperarSalida = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
  });

  child.kill("SIGTERM");
  await Promise.race([esperarSalida(), delay(5000)]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([esperarSalida(), delay(2000)]);
  }
}

async function crearUsuario({ nombre, email, passwordHash, esSuperadmin = false, debeCambiarPassword = false }) {
  return prisma.usuarios.create({
    data: {
      nombre,
      email,
      password: passwordHash,
      activo: true,
      es_superadmin: esSuperadmin,
      debe_cambiar_password: debeCambiarPassword,
    },
  });
}

export async function crearEntornoPruebas() {
  assert.notEqual(
    process.env.NODE_ENV?.trim().toLowerCase(),
    "production",
    "La suite se niega a ejecutarse con NODE_ENV=production.",
  );
  assert.ok(process.env.DB_NAME?.trim(), "Falta DB_NAME en .env.");
  assert.ok(process.env.JWT_SECRET?.trim(), "Falta JWT_SECRET en .env.");

  await prisma.$connect();
  const db = await prisma.$queryRaw`SELECT DATABASE() AS db`;
  const dbActual = db[0]?.db;

  assert.equal(dbActual, process.env.DB_NAME, "SELECT DATABASE() no coincide exactamente con DB_NAME.");
  assert.match(dbActual, /(_prueba|_test)$/i, "La suite solo puede escribir en una BD cuyo nombre termine en _prueba o _test.");

  const [rolAdmin, rolEmpleado] = await Promise.all([
    prisma.roles.findUnique({ where: { nombre: "admin" } }),
    prisma.roles.findUnique({ where: { nombre: "empleado" } }),
  ]);

  assert.ok(rolAdmin, 'No existe el rol "admin". No se crearon registros de prueba.');
  assert.ok(rolEmpleado, 'No existe el rol "empleado". No se crearon registros de prueba.');

  const runId = randomUUID().replaceAll("-", "").slice(0, 14);
  const emailPrefix = `api-test-${runId}-`;
  const passwordAdmin = `Suite-${runId}-Admin!`;
  const passwordEmployee = `Suite-${runId}-Employee!`;
  const passwordPending = `Suite-${runId}-Pending!`;
  const passwordCandidate = `Suite-${runId}-Candidate!`;
  const passwordSuperadmin = `Suite-${runId}-Superadmin!`;
  const passwordHash = await bcrypt.hash(passwordAdmin, 10);
  const extraCompanyIds = [];
  let company = null;
  let server = null;
  let productImageUrl = null;

  try {
    company = await prisma.empresas.create({
      data: { nombre: `__API_TEST_${runId}__`, descripcion: "Empresa temporal para pruebas automatizadas." },
    });

    const [admin, employee, pending, candidate, superadmin] = await Promise.all([
      crearUsuario({ nombre: `Suite Admin ${runId}`, email: `${emailPrefix}admin@invalid.test`, passwordHash }),
      crearUsuario({ nombre: `Suite Employee ${runId}`, email: `${emailPrefix}employee@invalid.test`, passwordHash: await bcrypt.hash(passwordEmployee, 10) }),
      crearUsuario({ nombre: `Suite Pending ${runId}`, email: `${emailPrefix}pending@invalid.test`, passwordHash: await bcrypt.hash(passwordPending, 10), debeCambiarPassword: true }),
      crearUsuario({ nombre: `Suite Candidate ${runId}`, email: `${emailPrefix}candidate@invalid.test`, passwordHash: await bcrypt.hash(passwordCandidate, 10) }),
      crearUsuario({ nombre: `Suite Superadmin ${runId}`, email: `${emailPrefix}superadmin@invalid.test`, passwordHash: await bcrypt.hash(passwordSuperadmin, 10), esSuperadmin: true }),
    ]);
    await prisma.usuarios_empresas.createMany({
      data: [
        { usuarios_id: admin.id, empresas_id: company.id, roles_id: rolAdmin.id },
        { usuarios_id: employee.id, empresas_id: company.id, roles_id: rolEmpleado.id },
      ],
    });

    const token = (id, empresasId) => jwt.sign(
      empresasId ? { id, empresas_id: empresasId } : { id },
      process.env.JWT_SECRET,
      { expiresIn: "1h" },
    );

    const tokens = {
      admin: token(admin.id, company.id),
      adminSinEmpresa: token(admin.id),
      employee: token(employee.id, company.id),
      pending: token(pending.id),
      superadmin: token(superadmin.id),
    };

    server = await iniciarServidor(company.id);
    console.log(`[suite-api:${runId}] BD ${dbActual}; empresa temporal ${company.id}; API aislada en ${server.baseUrl}`);

    return {
      dbName: dbActual,
      runId,
      emailPrefix,
      company,
      users: { admin, employee, pending, candidate, superadmin },
      passwords: { admin: passwordAdmin, employee: passwordEmployee, pending: passwordPending, candidate: passwordCandidate, superadmin: passwordSuperadmin },
      tokens,
      server,
      extraCompanyIds,
      get productImageUrl() { return productImageUrl; },
      set productImageUrl(value) { productImageUrl = value; },
    };
  } catch (error) {
    await detenerServidor(server);
    if (company?.id) {
      await limpiarEmpresaTemporal(company.id, runId).catch((cleanupError) => {
        console.error("Limpieza parcial de fixtures fallida:", cleanupError.message);
      });
    }
    await prisma.usuarios.deleteMany({ where: { email: { startsWith: emailPrefix } } }).catch((cleanupError) => {
      console.error("No se pudieron limpiar los usuarios temporales:", cleanupError.message);
    });
    await prisma.$disconnect().catch((disconnectError) => {
      console.error("No se pudo cerrar la conexión de Prisma:", disconnectError.message);
    });
    throw error;
  }
}

export function crearClienteApi(entorno, cobertura) {
  return async function request(method, pathName, options = {}) {
    const { token, body, form, routeKey } = options;
    const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 15_000;
    const methodUpper = method.toUpperCase();
    if (routeKey) cobertura.add(`${methodUpper} ${routeKey}`);

    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let requestBody;
    if (form) {
      requestBody = form;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const trace = process.env.SUITE_TRACE === "1";
    const startedAt = Date.now();
    const requestId = ++secuenciaPeticionHttp;
    const requestState = {
      id: requestId,
      method: methodUpper,
      path: pathName,
      iniciadaEn: startedAt,
      timeoutMs,
    };
    peticionesHttpActivas.set(requestId, requestState);
    if (trace) process.stderr.write(`[suite-http] INICIO ${methodUpper} ${pathName}\n`);
    try {
      const response = await fetch(new URL(pathName, entorno.server.baseUrl), {
        method: methodUpper,
        headers,
        body: requestBody,
        signal: controller.signal,
      });

      // El límite cubre la recepción de encabezados y la lectura del cuerpo HTTP.
      const raw = await response.text();
      let json = null;
      if (raw) {
        try { json = JSON.parse(raw); }
        catch { json = { raw }; }
      }

      ultimaPeticionHttp = {
        method: methodUpper,
        path: pathName,
        resultado: `HTTP ${response.status}`,
        finalizadaEn: Date.now(),
        duracionMs: Date.now() - startedAt,
      };
      if (trace) process.stderr.write(`[suite-http] FIN ${methodUpper} ${pathName} HTTP ${response.status} en ${Date.now() - startedAt} ms\n`);
      return { status: response.status, headers: response.headers, json };
    } catch (error) {
      ultimaPeticionHttp = {
        method: methodUpper,
        path: pathName,
        resultado: controller.signal.aborted ? `TIMEOUT ${timeoutMs} ms` : `ERROR ${error.message}`,
        finalizadaEn: Date.now(),
        duracionMs: Date.now() - startedAt,
      };
      if (trace) process.stderr.write(`[suite-http] ERROR ${methodUpper} ${pathName} en ${Date.now() - startedAt} ms: ${error.message}\n`);
      const logs = entorno.server?.getOutput?.() ?? "";
      const causa = controller.signal.aborted
        ? `superó el límite de ${timeoutMs} ms`
        : error.message;
      throw new Error(
        `${methodUpper} ${pathName} no completó la petición: ${causa}.\n` +
        `Últimos registros de la API de pruebas:\n${logs.slice(-6000) || "(sin salida capturada)"}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
      peticionesHttpActivas.delete(requestId);
    }
  };
}

async function limpiarEmpresaTemporal(companyId, runId) {
  const empresa = await prisma.empresas.findUnique({
    where: { id: companyId },
    select: { nombre: true },
  });
  if (!empresa) return;

  const nombresPermitidos = [
    `__API_TEST_${runId}__`,
    `__API_TEST_SECUNDARIA_${runId}__`,
  ];
  assert.ok(
    nombresPermitidos.includes(empresa.nombre),
    `Limpieza cancelada: la empresa ${companyId} no pertenece a esta ejecución temporal.`,
  );

  await prisma.$transaction(async (tx) => {
    // Se borran primero las tablas que tienen FKs RESTRICT hacia los registros
    // que se eliminarán después. Todos los filtros están limitados a esta empresa.
    await tx.$executeRaw`DELETE FROM fondo_reposicion_movimientos WHERE empresas_id = ${companyId}`;
    await tx.$executeRaw`
      DELETE FROM movimientos_insumos
      WHERE insumos_id IN (SELECT id FROM insumos WHERE empresas_id = ${companyId})
         OR lotes_produccion_id IN (SELECT id FROM lotes_produccion WHERE empresas_id = ${companyId})
    `;
    await tx.$executeRaw`
      DELETE FROM lotes_produccion_items
      WHERE lotes_produccion_id IN (SELECT id FROM lotes_produccion WHERE empresas_id = ${companyId})
    `;
    await tx.$executeRaw`
      DELETE FROM lotes_produccion_ediciones
      WHERE lote_id IN (SELECT id FROM lotes_produccion WHERE empresas_id = ${companyId})
    `;
    await tx.$executeRaw`DELETE FROM conciliaciones_insumos WHERE empresas_id = ${companyId}`;
    await tx.$executeRaw`
      DELETE FROM compras_insumos_items
      WHERE compra_id IN (SELECT id FROM compras_insumos WHERE empresas_id = ${companyId})
    `;
    await tx.$executeRaw`DELETE FROM compras_insumos WHERE empresas_id = ${companyId}`;
    await tx.$executeRaw`
      DELETE FROM pagos_venta
      WHERE ventas_id IN (SELECT id FROM ventas WHERE empresas_id = ${companyId})
    `;
    await tx.$executeRaw`
      DELETE FROM ventas_items
      WHERE ventas_id IN (SELECT id FROM ventas WHERE empresas_id = ${companyId})
    `;
    await tx.$executeRaw`DELETE FROM saldos_cliente WHERE empresas_id = ${companyId}`;
    await tx.$executeRaw`DELETE FROM movimientos_caja WHERE empresas_id = ${companyId}`;
    await tx.$executeRaw`DELETE FROM ventas WHERE empresas_id = ${companyId}`;
    await tx.$executeRaw`DELETE FROM lotes_produccion WHERE empresas_id = ${companyId}`;
    await tx.$executeRaw`
      DELETE FROM recetas
      WHERE productos_id IN (SELECT id FROM productos WHERE empresas_id = ${companyId})
         OR insumos_id IN (SELECT id FROM insumos WHERE empresas_id = ${companyId})
    `;
    await tx.$executeRaw`DELETE FROM clientes WHERE empresas_id = ${companyId}`;
    await tx.$executeRaw`DELETE FROM productos WHERE empresas_id = ${companyId}`;
    await tx.$executeRaw`DELETE FROM insumos WHERE empresas_id = ${companyId}`;
    await tx.$executeRaw`DELETE FROM configuracion_servicios_publicos WHERE empresas_id = ${companyId}`;
    await tx.$executeRaw`DELETE FROM fondo_reposicion_config WHERE empresas_id = ${companyId}`;
    await tx.$executeRaw`DELETE FROM empresas WHERE id = ${companyId}`;
  });
}

export async function limpiarEntornoPruebas(entorno) {
  if (!entorno) return;
  const errors = [];

  await detenerServidor(entorno.server).catch((error) => errors.push(error));

  if (entorno.productImageUrl) {
    const filename = path.basename(entorno.productImageUrl);
    if (filename.startsWith("producto-") && filename === entorno.productImageUrl.split("/").pop()) {
      await unlink(path.join(process.cwd(), "uploads", "productos", filename)).catch((error) => {
        if (error.code !== "ENOENT") errors.push(error);
      });
    }
  }

  let databaseVerified = false;
  try {
    const db = await prisma.$queryRaw`SELECT DATABASE() AS db`;
    const dbActual = db[0]?.db;
    assert.equal(dbActual, process.env.DB_NAME, "La BD cambió durante las pruebas; limpieza de BD cancelada.");
    assert.match(dbActual, /(_prueba|_test)$/i, "La limpieza solo puede operar sobre una BD de pruebas.");
    databaseVerified = true;
  } catch (error) {
    errors.push(new Error(`No se pudo verificar la BD antes de limpiar: ${error.message}`));
  }

  if (databaseVerified) {
    for (const companyId of [...entorno.extraCompanyIds, entorno.company?.id].filter(Boolean)) {
      try {
        await limpiarEmpresaTemporal(companyId, entorno.runId);
      } catch (error) {
        errors.push(new Error(`No se pudo limpiar la empresa temporal ${companyId}: ${error.message}`));
      }
    }

    try {
      await prisma.usuarios.deleteMany({ where: { email: { startsWith: entorno.emailPrefix } } });
    } catch (error) {
      errors.push(new Error(`No se pudieron eliminar los usuarios temporales ${entorno.emailPrefix}: ${error.message}`));
    }

    try {
      const companyIds = [...entorno.extraCompanyIds, entorno.company?.id].filter(Boolean);
      const [empresasRestantes, usuariosRestantes] = await Promise.all([
        companyIds.length
          ? prisma.empresas.count({ where: { id: { in: companyIds } } })
          : Promise.resolve(0),
        prisma.usuarios.count({ where: { email: { startsWith: entorno.emailPrefix } } }),
      ]);

      if (empresasRestantes > 0) {
        errors.push(new Error(`La limpieza dejó ${empresasRestantes} empresa(s) temporal(es).`));
      }
      if (usuariosRestantes > 0) {
        errors.push(new Error(`La limpieza dejó ${usuariosRestantes} usuario(s) temporal(es).`));
      }
    } catch (error) {
      errors.push(new Error(`No se pudo verificar la limpieza final: ${error.message}`));
    }
  }

  await prisma.$disconnect().catch((error) => errors.push(error));

  if (errors.length) {
    throw new AggregateError(errors, "La limpieza de datos temporales no terminó completamente.");
  }

  console.log(`[suite-api:${entorno.runId}] Limpieza de empresa, usuarios e imagen temporal completada.`);
}
