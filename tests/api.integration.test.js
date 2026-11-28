import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import prismaOriginal from "../src/db/prisma.js";
import {
  EXPECTED_ENDPOINTS,
  FECHA_COLOMBIA,
  PERIODO_COLOMBIA,
  assertHttp,
  crearClienteApi,
  crearEntornoPruebas,
  limpiarEntornoPruebas,
  registrarFaseSuite,
  obtenerDiagnosticoSuite,
  instrumentarPrismaParaSuite,
} from "./helpers/runtime.js";
import { iniciarWatchdogSuite } from "./helpers/watchdog.js";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p5sAAAAASUVORK5CYII=";
const prisma = instrumentarPrismaParaSuite(prismaOriginal);

const traceSuite = (message) => {
  registrarFaseSuite(message);
  if (process.env.SUITE_TRACE === "1") process.stderr.write(`[suite-trace] ${message}\n`);
};

function testConDiagnostico(contexto, nombre, callback) {
  return contexto.test(nombre, async (contextoHijo) => {
    traceSuite(`INICIO subprueba: ${nombre}`);
    try {
      await callback(contextoHijo);
    } finally {
      traceSuite(`FIN subprueba: ${nombre}`);
    }
  });
}

async function crearCompraHistorica(entorno, insumoId) {
  const timestamp = new Date(Math.floor(Date.now() / 1000) * 1000);
  const fecha = new Date(`${FECHA_COLOMBIA}T05:00:00.000Z`);
  const monto = 12.5;

  const movimientoCaja = await prisma.movimientos_caja.create({
    data: {
      empresas_id: entorno.company.id,
      usuarios_id: entorno.users.admin.id,
      tipo: "gasto",
      categoria: "insumo",
      monto,
      descripcion: "Compra histórica temporal de la suite",
      fecha,
      created_at: timestamp,
    },
  });

  await prisma.movimientos_insumos.create({
    data: {
      insumos_id: insumoId,
      tipo: "entrada",
      cantidad: 1,
      costo_total: monto,
      anulado: false,
      nota: `Compra registrada en caja #${movimientoCaja.id}`,
      usuarios_id: entorno.users.admin.id,
      created_at: timestamp,
    },
  });

  await prisma.fondo_reposicion_movimientos.create({
    data: {
      empresas_id: entorno.company.id,
      tipo: "compra",
      origen: "compra_historica_suite",
      monto: 0,
      monto_solicitado: monto,
      monto_externo: monto,
      estado_calculo: "incompleto",
      movimiento_caja_id: movimientoCaja.id,
      fecha,
      created_at: timestamp,
    },
  });

  return movimientoCaja.id;
}

test("Suite integral de endpoints de Control Total", async (t) => {
  let entorno;
  let detenerWatchdog = null;
  const cobertura = new Set();

  try {
    traceSuite("Preparando fixtures y verificando entorno de pruebas");
    detenerWatchdog = iniciarWatchdogSuite({
      obtenerDiagnosticoSuite,
      obtenerEntorno: () => entorno,
    });
    entorno = await crearEntornoPruebas();
    traceSuite("Fixtures creados y API aislada disponible");
    const request = crearClienteApi(entorno, cobertura);
    const empresaId = entorno.company.id;
    const { admin, employee, pending, candidate } = entorno.users;
    const { admin: adminToken, adminSinEmpresa, employee: employeeToken, pending: pendingToken, superadmin: superadminToken } = entorno.tokens;

    let productoId;
    let insumoId;
    let insumoHistoricoId;
    let clienteId;
    let ventaId;
    let loteAnuladoId;
    let loteActivoId;
    let movimientoCompraId;
    let movimientoCajaManualId;
    let passwordTemporal;
    let usuarioCreadoApiId;
    let empresaSecundariaId;
    let adminTokenSecundaria;
    let productoAjenoId;
    let insumoAjenoId;
    let clienteAjenoId;

    await testConDiagnostico(t, "Health check y autenticación", async () => {
      const health = await request("GET", "/health", { routeKey: "/health" });
      assertHttp(health, 200, "GET /health");
      assert.equal(health.json?.status, "ok");

      const sinToken = await request("GET", "/api/auth/me");
      assertHttp(sinToken, 401, "GET /api/auth/me sin token");

      const tokenInvalido = await request("GET", "/api/productos", {
        routeKey: "/api/productos",
        token: "esto-no-es-un-jwt-valido",
      });
      assertHttp(tokenInvalido, 401, "GET /api/productos con token inválido");

      const productosSinToken = await request("GET", "/api/productos", {
        routeKey: "/api/productos",
      });
      assertHttp(productosSinToken, 401, "GET /api/productos sin token");

      const login = await request("POST", "/api/auth/login", {
        routeKey: "/api/auth/login",
        body: { email: admin.email, password: entorno.passwords.admin },
      });
      assertHttp(login, 200, "POST /api/auth/login");
      assert.ok(login.json?.data?.token);
      assert.equal(login.json.data.usuario.email, admin.email);

      const selectEmpresa = await request("POST", "/api/auth/select-empresa", {
        routeKey: "/api/auth/select-empresa",
        token: adminSinEmpresa,
        body: { empresas_id: empresaId },
      });
      assertHttp(selectEmpresa, 200, "POST /api/auth/select-empresa");
      assert.equal(selectEmpresa.json?.data?.rol, "admin");

      const perfil = await request("GET", "/api/auth/me", {
        routeKey: "/api/auth/me",
        token: adminToken,
      });
      assertHttp(perfil, 200, "GET /api/auth/me");
      assert.equal(perfil.json?.data?.usuario?.id, admin.id);

      const miembros = await request("GET", "/api/auth/usuarios", {
        routeKey: "/api/auth/usuarios",
        token: adminToken,
      });
      assertHttp(miembros, 200, "GET /api/auth/usuarios");

      const crearMiembro = await request("POST", "/api/auth/usuarios", {
        routeKey: "/api/auth/usuarios",
        token: adminToken,
        body: {
          nombre: `Usuario API ${entorno.runId}`,
          email: `${entorno.emailPrefix}api-created@invalid.test`,
          password: `Temporal-${entorno.runId}!`,
          rol: "empleado",
        },
      });
      assertHttp(crearMiembro, 201, "POST /api/auth/usuarios");
      usuarioCreadoApiId = crearMiembro.json?.data?.usuario?.id;
      assert.ok(usuarioCreadoApiId, "La creación de miembro debe devolver el ID del usuario.");

      const membresiaCreada = await prisma.usuarios_empresas.findUnique({
        where: { usuarios_id_empresas_id: { usuarios_id: usuarioCreadoApiId, empresas_id: empresaId } },
      });
      assert.ok(membresiaCreada, "Debe existir la membresía creada por el endpoint.");

      const desactivarMiembro = await request("DELETE", `/api/auth/usuarios/${membresiaCreada.id}`, {
        routeKey: "/api/auth/usuarios/:id",
        token: adminToken,
      });
      assertHttp(desactivarMiembro, 200, "DELETE /api/auth/usuarios/:id");

      const sinEmpresa = await request("GET", "/api/productos", { token: adminSinEmpresa });
      assertHttp(sinEmpresa, 403, "GET /api/productos sin empresa seleccionada");

      const empleadoLectura = await request("GET", "/api/productos", { token: employeeToken });
      assertHttp(empleadoLectura, 200, "GET /api/productos con empleado");

      const empleadoSinPermiso = await request("POST", "/api/productos", {
        routeKey: "/api/productos",
        token: employeeToken,
        body: { nombre: `Producto prohibido ${entorno.runId}`, precio_venta: 1 },
      });
      assertHttp(empleadoSinPermiso, 403, "POST /api/productos con empleado");
      const productoProhibido = await prisma.productos.count({
        where: { empresas_id: empresaId, nombre: `Producto prohibido ${entorno.runId}` },
      });
      assert.equal(productoProhibido, 0, "El rechazo por rol no debe crear productos.");
    });

    await testConDiagnostico(t, "Empresas, membresías y superadministración", async () => {
      const misEmpresas = await request("GET", "/api/empresas", {
        routeKey: "/api/empresas",
        token: adminToken,
      });
      assertHttp(misEmpresas, 200, "GET /api/empresas");

      const empresa = await request("GET", `/api/empresas/${empresaId}`, {
        routeKey: "/api/empresas/:id",
        token: adminToken,
      });
      assertHttp(empresa, 200, "GET /api/empresas/:id");
      assert.equal(empresa.json?.data?.id, empresaId);

      const actualizarEmpresa = await request("PUT", `/api/empresas/${empresaId}`, {
        routeKey: "/api/empresas/:id",
        token: adminToken,
        body: { descripcion: `Descripción actualizada por suite ${entorno.runId}`, activa: true },
      });
      assertHttp(actualizarEmpresa, 200, "PUT /api/empresas/:id");

      const miembrosEmpresa = await request("GET", `/api/empresas/${empresaId}/miembros`, {
        routeKey: "/api/empresas/:id/miembros",
        token: adminToken,
      });
      assertHttp(miembrosEmpresa, 200, "GET /api/empresas/:id/miembros");

      const rolEmpleado = await prisma.roles.findUnique({ where: { nombre: "empleado" } });
      const agregarMiembro = await request("POST", `/api/empresas/${empresaId}/miembros`, {
        routeKey: "/api/empresas/:id/miembros",
        token: adminToken,
        body: { usuarios_id: candidate.id, roles_id: rolEmpleado.id },
      });
      assertHttp(agregarMiembro, 201, "POST /api/empresas/:id/miembros");

      const quitarMiembro = await request("DELETE", `/api/empresas/${empresaId}/miembros/${candidate.id}`, {
        routeKey: "/api/empresas/:id/miembros/:userId",
        token: adminToken,
      });
      assertHttp(quitarMiembro, 204, "DELETE /api/empresas/:id/miembros/:userId");

      const listarEmpresasSuperadmin = await request("GET", "/api/superadmin/empresas", {
        routeKey: "/api/superadmin/empresas",
        token: superadminToken,
      });
      assertHttp(listarEmpresasSuperadmin, 200, "GET /api/superadmin/empresas");

      const sinPermisoSuperadmin = await request("GET", "/api/superadmin/empresas", { token: adminToken });
      assertHttp(sinPermisoSuperadmin, 403, "GET /api/superadmin/empresas con administrador normal");

      const crearEmpresaSecundaria = await request("POST", "/api/superadmin/empresas", {
        routeKey: "/api/superadmin/empresas",
        token: superadminToken,
        body: {
          nombre: `__API_TEST_SECUNDARIA_${entorno.runId}__`,
          descripcion: "Empresa temporal secundaria de la suite.",
          admin: { usuarios_id: admin.id },
        },
      });
      empresaSecundariaId = crearEmpresaSecundaria.json?.data?.empresa?.id;
      if (empresaSecundariaId) entorno.extraCompanyIds.push(empresaSecundariaId);
      assertHttp(crearEmpresaSecundaria, 201, "POST /api/superadmin/empresas");
      assert.ok(empresaSecundariaId);

      // El mismo administrador tiene membresía independiente en la empresa secundaria.
      // Se crean recursos ajenos exclusivamente allí para probar el aislamiento por tenant.
      adminTokenSecundaria = jwt.sign(
        { id: admin.id, empresas_id: empresaSecundariaId },
        process.env.JWT_SECRET,
        { expiresIn: "1h" },
      );

      const productoAjeno = await request("POST", "/api/productos", {
        routeKey: "/api/productos",
        token: adminTokenSecundaria,
        body: {
          nombre: `Producto Empresa B ${entorno.runId}`,
          descripcion: "Recurso aislado de la empresa secundaria.",
          precio_venta: 75,
        },
      });
      assertHttp(productoAjeno, 201, "Crear producto de empresa secundaria");
      productoAjenoId = productoAjeno.json?.data?.id;
      assert.ok(productoAjenoId);

      const insumoAjeno = await request("POST", "/api/insumos", {
        routeKey: "/api/insumos",
        token: adminTokenSecundaria,
        body: {
          nombre: `Insumo Empresa B ${entorno.runId}`,
          unidad_medida: "kg",
          stock_actual: 30,
          stock_minimo: 1,
          precio_unidad: 8,
        },
      });
      assertHttp(insumoAjeno, 201, "Crear insumo de empresa secundaria");
      insumoAjenoId = insumoAjeno.json?.data?.id;
      assert.ok(insumoAjenoId);

      const clienteAjeno = await request("POST", "/api/clientes", {
        routeKey: "/api/clientes",
        token: adminTokenSecundaria,
        body: {
          nombre: `Cliente Empresa B ${entorno.runId}`,
          telefono: "3000000002",
        },
      });
      assertHttp(clienteAjeno, 201, "Crear cliente de empresa secundaria");
      clienteAjenoId = clienteAjeno.json?.data?.id;
      assert.ok(clienteAjenoId);

      const accesoOtraEmpresa = await request("GET", `/api/empresas/${empresaSecundariaId}`, {
        routeKey: "/api/empresas/:id",
        token: adminToken,
      });
      assertHttp(accesoOtraEmpresa, 403, "GET /api/empresas/:id de otra empresa");

      const productoAjenoAntes = await prisma.productos.findUnique({
        where: { id: productoAjenoId },
        select: { nombre: true, precio_venta: true, empresas_id: true },
      });
      const productoAjenoNoVisible = await request("GET", `/api/productos/${productoAjenoId}`, {
        routeKey: "/api/productos/:id",
        token: adminToken,
      });
      assertHttp(productoAjenoNoVisible, 404, "GET producto de otra empresa");

      const modificarProductoAjeno = await request("PUT", `/api/productos/${productoAjenoId}`, {
        routeKey: "/api/productos/:id",
        token: adminToken,
        body: { nombre: `Intento de modificación ${entorno.runId}`, precio_venta: 999 },
      });
      assertHttp(modificarProductoAjeno, 404, "PUT producto de otra empresa");
      const productoAjenoDespues = await prisma.productos.findUnique({
        where: { id: productoAjenoId },
        select: { nombre: true, precio_venta: true, empresas_id: true },
      });
      assert.equal(productoAjenoDespues.nombre, productoAjenoAntes.nombre);
      assert.equal(Number(productoAjenoDespues.precio_venta), Number(productoAjenoAntes.precio_venta));
      assert.equal(productoAjenoDespues.empresas_id, empresaSecundariaId);

      const insumoAjenoAntes = await prisma.insumos.findUnique({
        where: { id: insumoAjenoId },
        select: { nombre: true, stock_actual: true, empresas_id: true },
      });
      const insumoAjenoNoVisible = await request("GET", `/api/insumos/${insumoAjenoId}`, {
        routeKey: "/api/insumos/:id",
        token: adminToken,
      });
      assertHttp(insumoAjenoNoVisible, 404, "GET insumo de otra empresa");

      const modificarInsumoAjeno = await request("PUT", `/api/insumos/${insumoAjenoId}`, {
        routeKey: "/api/insumos/:id",
        token: adminToken,
        body: { nombre: `Intento de modificación ${entorno.runId}` },
      });
      assertHttp(modificarInsumoAjeno, 404, "PUT insumo de otra empresa");
      const insumoAjenoDespues = await prisma.insumos.findUnique({
        where: { id: insumoAjenoId },
        select: { nombre: true, stock_actual: true, empresas_id: true },
      });
      assert.equal(insumoAjenoDespues.nombre, insumoAjenoAntes.nombre);
      assert.equal(Number(insumoAjenoDespues.stock_actual), Number(insumoAjenoAntes.stock_actual));
      assert.equal(insumoAjenoDespues.empresas_id, empresaSecundariaId);

      const clienteAjenoNoVisible = await request("GET", `/api/clientes/${clienteAjenoId}`, {
        routeKey: "/api/clientes/:id",
        token: adminToken,
      });
      assertHttp(clienteAjenoNoVisible, 404, "GET cliente de otra empresa");

      const listarUsuariosSuperadmin = await request("GET", "/api/superadmin/usuarios", {
        routeKey: "/api/superadmin/usuarios",
        token: superadminToken,
      });
      assertHttp(listarUsuariosSuperadmin, 200, "GET /api/superadmin/usuarios");

      const regenerarTemporal = await request("POST", `/api/superadmin/usuarios/${pending.id}/password-temporal`, {
        routeKey: "/api/superadmin/usuarios/:id/password-temporal",
        token: superadminToken,
      });
      assertHttp(regenerarTemporal, 200, "POST /api/superadmin/usuarios/:id/password-temporal");
      passwordTemporal = regenerarTemporal.json?.data?.password_temporal;
      assert.ok(passwordTemporal, "El endpoint debe devolver la contraseña temporal.");

      const bloqueadoCambio = await request("GET", "/api/auth/me", { token: pendingToken });
      assertHttp(bloqueadoCambio, 403, "GET /api/auth/me antes de cambiar contraseña");
      assert.equal(bloqueadoCambio.json?.code, "DEBE_CAMBIAR_PASSWORD");

      const operacionConPasswordPendiente = await request("POST", "/api/productos", {
        routeKey: "/api/productos",
        token: pendingToken,
        body: { nombre: `Producto bloqueado ${entorno.runId}`, precio_venta: 1 },
      });
      assertHttp(operacionConPasswordPendiente, 403, "POST /api/productos con cambio de contraseña pendiente");
      assert.equal(operacionConPasswordPendiente.json?.code, "DEBE_CAMBIAR_PASSWORD");
      assert.equal(await prisma.productos.count({
        where: { empresas_id: empresaId, nombre: `Producto bloqueado ${entorno.runId}` },
      }), 0, "Un usuario con cambio de contraseña pendiente no debe crear productos.");

      const cambiarPassword = await request("POST", "/api/auth/cambiar-password", {
        routeKey: "/api/auth/cambiar-password",
        token: pendingToken,
        body: { password_actual: passwordTemporal, password_nuevo: `Nueva-${entorno.runId}-Clave!` },
      });
      assertHttp(cambiarPassword, 200, "POST /api/auth/cambiar-password");

      const perfilDesbloqueado = await request("GET", "/api/auth/me", { token: pendingToken });
      assertHttp(perfilDesbloqueado, 200, "GET /api/auth/me después de cambiar contraseña");
    });

    await testConDiagnostico(t, "Productos e insumos: alta, ajustes, conciliación y receta", async () => {
      const insumosIniciales = await request("GET", "/api/insumos", {
        routeKey: "/api/insumos",
        token: adminToken,
      });
      assertHttp(insumosIniciales, 200, "GET /api/insumos");

      const crearInsumo = await request("POST", "/api/insumos", {
        routeKey: "/api/insumos",
        token: adminToken,
        body: {
          nombre: `Insumo Suite ${entorno.runId}`,
          unidad_medida: "kg",
          stock_actual: 10,
          stock_minimo: 1,
          precio_unidad: 10,
        },
      });
      assertHttp(crearInsumo, 201, "POST /api/insumos");
      insumoId = crearInsumo.json?.data?.id;
      assert.ok(insumoId);

      const insumo = await request("GET", `/api/insumos/${insumoId}`, {
        routeKey: "/api/insumos/:id",
        token: adminToken,
      });
      assertHttp(insumo, 200, "GET /api/insumos/:id");

      const insumoAntesDeRechazos = await prisma.insumos.findUnique({
        where: { id: insumoId },
        select: { stock_actual: true, precio_unidad: true },
      });
      const movimientosInsumoAntesDeRechazos = await prisma.movimientos_insumos.count({
        where: { insumos_id: insumoId },
      });

      const ajusteNegativo = await request("POST", `/api/insumos/${insumoId}/ajuste`, {
        routeKey: "/api/insumos/:id/ajuste",
        token: adminToken,
        body: { stock_real: -1, motivo: "Prueba negativa de la suite" },
      });
      assertHttp(ajusteNegativo, 400, "Ajuste de inventario con stock negativo");

      const ajusteEmpleado = await request("POST", `/api/insumos/${insumoId}/ajuste`, {
        routeKey: "/api/insumos/:id/ajuste",
        token: employeeToken,
        body: { stock_real: 99, motivo: "El empleado no debe ajustar inventario" },
      });
      assertHttp(ajusteEmpleado, 403, "Ajuste de inventario con rol empleado");

      const insumoTrasRechazos = await prisma.insumos.findUnique({
        where: { id: insumoId },
        select: { stock_actual: true, precio_unidad: true },
      });
      const movimientosInsumoTrasRechazos = await prisma.movimientos_insumos.count({
        where: { insumos_id: insumoId },
      });
      assert.equal(Number(insumoTrasRechazos.stock_actual), Number(insumoAntesDeRechazos.stock_actual));
      assert.equal(Number(insumoTrasRechazos.precio_unidad), Number(insumoAntesDeRechazos.precio_unidad));
      assert.equal(movimientosInsumoTrasRechazos, movimientosInsumoAntesDeRechazos);

      const ajuste = await request("POST", `/api/insumos/${insumoId}/ajuste`, {
        routeKey: "/api/insumos/:id/ajuste",
        token: adminToken,
        body: { stock_real: 9, motivo: "Ajuste controlado de suite" },
      });
      assertHttp(ajuste, 200, "POST /api/insumos/:id/ajuste");

      const conciliacion = await request("POST", `/api/insumos/${insumoId}/conciliacion`, {
        routeKey: "/api/insumos/:id/conciliacion",
        token: adminToken,
        body: { stock_real: 9, valor_total: 90, motivo: "Conciliación controlada de suite" },
      });
      assertHttp(conciliacion, 201, "POST /api/insumos/:id/conciliacion");

      const conciliaciones = await request("GET", `/api/insumos/${insumoId}/conciliaciones`, {
        routeKey: "/api/insumos/:id/conciliaciones",
        token: adminToken,
      });
      assertHttp(conciliaciones, 200, "GET /api/insumos/:id/conciliaciones");
      assert.ok(Array.isArray(conciliaciones.json?.data));
      assert.ok(conciliaciones.json.data.length >= 1);

      const actualizarInsumo = await request("PUT", `/api/insumos/${insumoId}`, {
        routeKey: "/api/insumos/:id",
        token: adminToken,
        body: { nombre: `Insumo Suite Modificado ${entorno.runId}`, stock_minimo: 1 },
      });
      assertHttp(actualizarInsumo, 200, "PUT /api/insumos/:id");

      const productoNegativo = await request("POST", "/api/productos", {
        routeKey: "/api/productos",
        token: adminToken,
        body: {
          nombre: `Producto precio negativo ${entorno.runId}`,
          precio_venta: -1,
        },
      });
      assertHttp(productoNegativo, 400, "POST /api/productos con precio negativo");
      assert.equal(await prisma.productos.count({
        where: { empresas_id: empresaId, nombre: `Producto precio negativo ${entorno.runId}` },
      }), 0, "Un producto con precio negativo no debe persistirse.");

      const crearProducto = await request("POST", "/api/productos", {
        routeKey: "/api/productos",
        token: adminToken,
        body: {
          nombre: `Producto Suite ${entorno.runId}`,
          descripcion: "Producto temporal de integración.",
          precio_venta: 40,
          usa_energia: true,
        },
      });
      assertHttp(crearProducto, 201, "POST /api/productos");
      productoId = crearProducto.json?.data?.id;
      assert.ok(productoId);

      const productosLista = await request("GET", "/api/productos?page=1&limit=20", {
        routeKey: "/api/productos",
        token: adminToken,
      });
      assertHttp(productosLista, 200, "GET /api/productos");

      const producto = await request("GET", `/api/productos/${productoId}`, {
        routeKey: "/api/productos/:id",
        token: adminToken,
      });
      assertHttp(producto, 200, "GET /api/productos/:id");

      const actualizarProducto = await request("PUT", `/api/productos/${productoId}`, {
        routeKey: "/api/productos/:id",
        token: adminToken,
        body: {
          nombre: `Producto Suite Actualizado ${entorno.runId}`,
          descripcion: "Producto temporal actualizado por la suite.",
          precio_venta: 40,
          usa_energia: true,
        },
      });
      assertHttp(actualizarProducto, 200, "PUT /api/productos/:id");

      const nombreProductoAntesDeRechazoEmpleado = (await prisma.productos.findUnique({
        where: { id: productoId },
        select: { nombre: true, precio_venta: true },
      }));
      const editarProductoEmpleado = await request("PUT", `/api/productos/${productoId}`, {
        routeKey: "/api/productos/:id",
        token: employeeToken,
        body: { nombre: `Edición prohibida ${entorno.runId}`, precio_venta: 999 },
      });
      assertHttp(editarProductoEmpleado, 403, "PUT /api/productos/:id con rol empleado");
      const productoTrasRechazoEmpleado = await prisma.productos.findUnique({
        where: { id: productoId },
        select: { nombre: true, precio_venta: true },
      });
      assert.equal(productoTrasRechazoEmpleado.nombre, nombreProductoAntesDeRechazoEmpleado.nombre);
      assert.equal(Number(productoTrasRechazoEmpleado.precio_venta), Number(nombreProductoAntesDeRechazoEmpleado.precio_venta));

      const recetasAntesDeReferenciaAjena = await prisma.recetas.count({ where: { productos_id: productoId } });
      const recetaConInsumoAjeno = await request("PUT", `/api/productos/${productoId}/receta`, {
        routeKey: "/api/productos/:id/receta",
        token: adminToken,
        body: { insumos: [{ insumos_id: insumoAjenoId, cantidad: 0.1 }] },
      });
      assertHttp(recetaConInsumoAjeno, 400, "PUT receta con insumo de otra empresa");
      assert.equal(
        await prisma.recetas.count({ where: { productos_id: productoId } }),
        recetasAntesDeReferenciaAjena,
        "Una receta que referencia un insumo ajeno no debe reemplazar la receta existente.",
      );

      const receta = await request("PUT", `/api/productos/${productoId}/receta`, {
        routeKey: "/api/productos/:id/receta",
        token: adminToken,
        body: { insumos: [{ insumos_id: insumoId, cantidad: 0.1 }] },
      });
      assertHttp(receta, 200, "PUT /api/productos/:id/receta");

      const form = new FormData();
      form.append("imagen", new Blob([Buffer.from(PNG_1X1, "base64")], { type: "image/png" }), "suite.png");
      const imagen = await request("POST", `/api/productos/${productoId}/imagen`, {
        routeKey: "/api/productos/:id/imagen",
        token: adminToken,
        form,
      });
      assertHttp(imagen, 200, "POST /api/productos/:id/imagen");
      entorno.productImageUrl = imagen.json?.data?.imagen_url ?? null;
      assert.ok(entorno.productImageUrl?.startsWith("/uploads/productos/"));
    });

    await testConDiagnostico(t, "Caja, compras, recuperación histórica y servicios públicos", async (tCaja) => {
      traceSuite("CAJA 00 - inicio del grupo");
      const obtenerBalanceCajaSuite = async () => {
        const [ingresos, gastos] = await Promise.all([
          prisma.movimientos_caja.aggregate({
            where: { empresas_id: empresaId, anulado: false, tipo: "ingreso" },
            _sum: { monto: true },
          }),
          prisma.movimientos_caja.aggregate({
            where: { empresas_id: empresaId, anulado: false, tipo: "gasto" },
            _sum: { monto: true },
          }),
        ]);
        return Math.round((Number(ingresos._sum.monto ?? 0) - Number(gastos._sum.monto ?? 0)) * 100) / 100;
      };
      traceSuite("CAJA 01 - antes de count movimientos_caja");
      const movimientosCajaAntesDeRechazos = await prisma.movimientos_caja.count({ where: { empresas_id: empresaId } });
      traceSuite("CAJA 02 - count movimientos_caja completado");
      const stockAntesDeRechazosCaja = await prisma.insumos.findUnique({
        where: { id: insumoId },
        select: { stock_actual: true },
      });
      const stockInsumoAjenoAntesDeRechazosCaja = await prisma.insumos.findUnique({
        where: { id: insumoAjenoId },
        select: { stock_actual: true },
      });

      const compraSinDetalle = await request("POST", "/api/caja", {
        routeKey: "/api/caja",
        token: adminToken,
        body: {
          tipo: "gasto",
          categoria: "insumo",
          monto: 100,
          descripcion: "Esta compra inválida no debe persistirse",
          fecha: FECHA_COLOMBIA,
        },
      });
      assertHttp(compraSinDetalle, 400, "POST /api/caja compra de insumos sin detalle");

      const compraConInsumoAjeno = await request("POST", "/api/caja", {
        routeKey: "/api/caja",
        token: adminToken,
        body: {
          tipo: "gasto",
          categoria: "insumo",
          monto: 8,
          descripcion: "No se debe aceptar un insumo de otra empresa",
          fecha: FECHA_COLOMBIA,
          insumos: [{ insumos_id: insumoAjenoId, cantidad: 1, costo_unitario: 8 }],
        },
      });
      assertHttp(compraConInsumoAjeno, 400, "POST /api/caja compra con insumo de otra empresa");

      const cajaMontoNegativo = await request("POST", "/api/caja", {
        routeKey: "/api/caja",
        token: adminToken,
        body: {
          tipo: "gasto",
          categoria: "otro",
          monto: -10,
          descripcion: "Este monto inválido no debe persistirse",
          fecha: FECHA_COLOMBIA,
        },
      });
      assertHttp(cajaMontoNegativo, 400, "POST /api/caja con monto negativo");

      assert.equal(
        await prisma.movimientos_caja.count({ where: { empresas_id: empresaId } }),
        movimientosCajaAntesDeRechazos,
        "Las operaciones de Caja rechazadas no deben crear movimientos.",
      );
      const stockTrasRechazosCaja = await prisma.insumos.findUnique({
        where: { id: insumoId },
        select: { stock_actual: true },
      });
      assert.equal(Number(stockTrasRechazosCaja.stock_actual), Number(stockAntesDeRechazosCaja.stock_actual));
      const stockInsumoAjenoTrasRechazosCaja = await prisma.insumos.findUnique({
        where: { id: insumoAjenoId },
        select: { stock_actual: true },
      });
      assert.equal(
        Number(stockInsumoAjenoTrasRechazosCaja.stock_actual),
        Number(stockInsumoAjenoAntesDeRechazosCaja.stock_actual),
        "Una compra rechazada no debe alterar el inventario de otra empresa.",
      );

      await testConDiagnostico(tCaja, "Ciclo financiero de compra: editar y anular sin duplicar Caja, inventario ni Fondo", async () => {
        const insumoAntesCompra = await prisma.insumos.findUnique({
          where: { id: insumoId },
          select: { stock_actual: true },
        });
        const stockAntesCompra = Number(insumoAntesCompra.stock_actual);
        const balanceCajaAntesCompra = await obtenerBalanceCajaSuite();

        traceSuite("COMPRA FINANCIERA 01 - antes POST compra estructurada");
        const compra = await request("POST", "/api/caja", {
          routeKey: "/api/caja",
          token: adminToken,
          body: {
            tipo: "gasto",
            categoria: "insumo",
            monto: 100,
            descripcion: "Compra de inventario para suite",
            fecha: FECHA_COLOMBIA,
            insumos: [{ insumos_id: insumoId, cantidad: 10, costo_unitario: 10 }],
          },
        });
        assertHttp(compra, 201, "POST /api/caja compra de insumos");
        movimientoCompraId = compra.json?.data?.id;
        assert.ok(movimientoCompraId);

        const movimientoCajaInicial = await prisma.movimientos_caja.findUnique({
          where: { id: movimientoCompraId },
        });
        const compraInicial = await prisma.compras_insumos.findFirst({
          where: { movimientos_caja_id: movimientoCompraId },
          include: { items: { include: { movimiento_insumos: true } } },
        });
        const eventosFondoIniciales = await prisma.fondo_reposicion_movimientos.findMany({
          where: { empresas_id: empresaId, movimiento_caja_id: movimientoCompraId, tipo: "compra" },
        });
        const insumoDespuesCompra = await prisma.insumos.findUnique({
          where: { id: insumoId },
          select: { stock_actual: true },
        });

        assert.equal(Number(movimientoCajaInicial.monto), 100);
        assert.equal(movimientoCajaInicial.anulado, false);
        assert.ok(compraInicial);
        assert.equal(Number(compraInicial.monto_total), 100);
        assert.equal(compraInicial.anulada, false);
        assert.equal(compraInicial.items.length, 1);
        assert.equal(Number(compraInicial.items[0].cantidad), 10);
        assert.equal(Number(compraInicial.items[0].costo_total), 100);
        assert.ok(compraInicial.items[0].movimiento_insumos);
        assert.equal(Number(insumoDespuesCompra.stock_actual), stockAntesCompra + 10);
        assert.equal(await obtenerBalanceCajaSuite(), Math.round((balanceCajaAntesCompra - 100) * 100) / 100);
        assert.equal(eventosFondoIniciales.length, 1, "La compra debe generar exactamente un evento del Fondo.");
        assert.equal(Number(eventosFondoIniciales[0].monto_solicitado), 100);
        assert.equal(eventosFondoIniciales[0].anulado, false);

        traceSuite("COMPRA FINANCIERA 02 - antes PUT actualizar compra");
        const actualizarCompra = await request("PUT", `/api/caja/${movimientoCompraId}`, {
          routeKey: "/api/caja/:id",
          token: adminToken,
          body: {
            tipo: "gasto",
            categoria: "insumo",
            monto: 110,
            descripcion: "Compra de inventario actualizada por suite",
            fecha: FECHA_COLOMBIA,
            insumos: [{ insumos_id: insumoId, cantidad: 11, costo_unitario: 10 }],
          },
        });
        assertHttp(actualizarCompra, 200, "PUT /api/caja/:id compra de insumos");

        const movimientoCajaActualizado = await prisma.movimientos_caja.findUnique({
          where: { id: movimientoCompraId },
        });
        const compraActualizada = await prisma.compras_insumos.findFirst({
          where: { movimientos_caja_id: movimientoCompraId },
          include: { items: { include: { movimiento_insumos: true } } },
        });
        const eventosFondoActualizados = await prisma.fondo_reposicion_movimientos.findMany({
          where: { empresas_id: empresaId, movimiento_caja_id: movimientoCompraId, tipo: "compra" },
        });
        const insumoDespuesEdicion = await prisma.insumos.findUnique({
          where: { id: insumoId },
          select: { stock_actual: true },
        });

        assert.equal(Number(movimientoCajaActualizado.monto), 110);
        assert.equal(movimientoCajaActualizado.anulado, false);
        assert.equal(compraActualizada.id, compraInicial.id, "Editar no debe crear otra compra vinculada.");
        assert.equal(Number(compraActualizada.monto_total), 110);
        assert.equal(compraActualizada.anulada, false);
        assert.equal(compraActualizada.items.length, 1);
        assert.equal(compraActualizada.items[0].id, compraInicial.items[0].id, "La edición debe conservar el detalle original.");
        assert.equal(Number(compraActualizada.items[0].cantidad), 11);
        assert.equal(Number(compraActualizada.items[0].costo_unitario), 10);
        assert.equal(Number(compraActualizada.items[0].costo_total), 110);
        assert.equal(compraActualizada.items[0].movimiento_insumos.id, compraInicial.items[0].movimiento_insumos.id);
        assert.equal(Number(compraActualizada.items[0].movimiento_insumos.cantidad), 11);
        assert.equal(Number(compraActualizada.items[0].movimiento_insumos.costo_total), 110);
        assert.equal(compraActualizada.items[0].movimiento_insumos.anulado, false);
        assert.equal(Number(insumoDespuesEdicion.stock_actual), stockAntesCompra + 11);
        assert.equal(await obtenerBalanceCajaSuite(), Math.round((balanceCajaAntesCompra - 110) * 100) / 100);
        assert.equal(eventosFondoActualizados.length, 1, "Editar no debe duplicar el evento del Fondo.");
        assert.equal(eventosFondoActualizados[0].id, eventosFondoIniciales[0].id);
        assert.equal(Number(eventosFondoActualizados[0].monto_solicitado), 110);
        assert.equal(eventosFondoActualizados[0].anulado, false);

        traceSuite("COMPRA FINANCIERA 03 - antes anular compra editada");
        const anularCompra = await request("DELETE", `/api/caja/${movimientoCompraId}`, {
          routeKey: "/api/caja/:id",
          token: adminToken,
          body: { motivo: "Anulación del ciclo de compra de la suite" },
        });
        assertHttp(anularCompra, 200, "DELETE /api/caja/:id compra de insumos");

        const movimientoCajaAnulado = await prisma.movimientos_caja.findUnique({
          where: { id: movimientoCompraId },
        });
        const compraAnulada = await prisma.compras_insumos.findUnique({
          where: { id: compraInicial.id },
          include: { items: { include: { movimiento_insumos: true } } },
        });
        const eventoFondoAnulado = await prisma.fondo_reposicion_movimientos.findMany({
          where: { empresas_id: empresaId, movimiento_caja_id: movimientoCompraId, tipo: "compra" },
        });
        const insumoDespuesAnular = await prisma.insumos.findUnique({
          where: { id: insumoId },
          select: { stock_actual: true },
        });
        const balanceCajaDespuesCompra = await obtenerBalanceCajaSuite();

        assert.equal(movimientoCajaAnulado.anulado, true);
        assert.equal(compraAnulada.anulada, true);
        assert.equal(compraAnulada.items.length, 1);
        assert.equal(compraAnulada.items[0].movimiento_insumos.anulado, true);
        assert.equal(await prisma.movimientos_insumos.count({
          where: { insumos_id: insumoId, compra_item_id: compraInicial.items[0].id, anulado: false },
        }), 0, "La anulación no debe dejar activa la entrada de inventario de la compra.");
        assert.equal(Number(insumoDespuesAnular.stock_actual), stockAntesCompra, "Anular debe devolver exactamente el stock previo a la compra.");
        assert.equal(eventoFondoAnulado.length, 1);
        assert.equal(eventoFondoAnulado[0].id, eventosFondoIniciales[0].id);
        assert.equal(eventoFondoAnulado[0].anulado, true);
        assert.equal(balanceCajaDespuesCompra, balanceCajaAntesCompra, "Anular la compra debe restaurar el balance previo de Caja.");
        traceSuite("COMPRA FINANCIERA 04 - edición y anulación verificadas");
      });

      insumoHistoricoId = (await prisma.insumos.create({
        data: {
          empresas_id: empresaId,
          nombre: `Insumo Histórico Suite ${entorno.runId}`,
          unidad_medida: "kg",
          stock_actual: 0,
          stock_minimo: 0,
          precio_unidad: 12.5,
          estado_costo: "verificado",
        },
      })).id;
      traceSuite("CAJA 14 - antes crear compra historica directa en Prisma");
      const movimientoHistoricoId = await crearCompraHistorica(entorno, insumoHistoricoId);
      traceSuite("CAJA 15 - compra historica creada");

      traceSuite("CAJA 16 - antes recuperar compra historica por API");
      const recuperarHistorica = await request("POST", `/api/caja/compras-historicas/${movimientoHistoricoId}/recuperar`, {
        routeKey: "/api/caja/compras-historicas/:id/recuperar",
        token: adminToken,
      });
      assertHttp(recuperarHistorica, 200, "POST /api/caja/compras-historicas/:id/recuperar");
      assert.equal(recuperarHistorica.json?.data?.ya_recuperada, false);

      const repetirRecuperacion = await request("POST", `/api/caja/compras-historicas/${movimientoHistoricoId}/recuperar`, {
        token: adminToken,
      });
      assertHttp(repetirRecuperacion, 200, "Repetir recuperación histórica");
      assert.equal(repetirRecuperacion.json?.data?.ya_recuperada, true);

      await testConDiagnostico(tCaja, "Ciclo de gasto manual: editar y anular restaura el balance de Caja", async () => {
        const balanceAntesGasto = await obtenerBalanceCajaSuite();
        const eventosFondoAntesGasto = await prisma.fondo_reposicion_movimientos.count({
          where: { empresas_id: empresaId },
        });

        const gasto = await request("POST", "/api/caja", {
          routeKey: "/api/caja",
          token: adminToken,
          body: {
            tipo: "gasto",
            categoria: "otro",
            monto: 8,
            descripcion: "Gasto independiente temporal",
            fecha: FECHA_COLOMBIA,
          },
        });
        assertHttp(gasto, 201, "POST /api/caja movimiento independiente");
        movimientoCajaManualId = gasto.json?.data?.id;
        assert.ok(movimientoCajaManualId);

        const gastoCreado = await prisma.movimientos_caja.findUnique({ where: { id: movimientoCajaManualId } });
        assert.equal(Number(gastoCreado.monto), 8);
        assert.equal(gastoCreado.anulado, false);
        assert.equal(await obtenerBalanceCajaSuite(), Math.round((balanceAntesGasto - 8) * 100) / 100);

        const actualizarGasto = await request("PUT", `/api/caja/${movimientoCajaManualId}`, {
          routeKey: "/api/caja/:id",
          token: adminToken,
          body: {
            tipo: "gasto",
            categoria: "otro",
            monto: 9,
            descripcion: "Gasto actualizado temporal",
            fecha: FECHA_COLOMBIA,
          },
        });
        assertHttp(actualizarGasto, 200, "PUT /api/caja/:id movimiento independiente");

        const gastoActualizado = await prisma.movimientos_caja.findUnique({ where: { id: movimientoCajaManualId } });
        assert.equal(Number(gastoActualizado.monto), 9);
        assert.equal(gastoActualizado.anulado, false);
        assert.equal(await obtenerBalanceCajaSuite(), Math.round((balanceAntesGasto - 9) * 100) / 100);
        assert.equal(await prisma.movimientos_caja.count({ where: { empresas_id: empresaId, id: movimientoCajaManualId } }), 1);
        assert.equal(await prisma.fondo_reposicion_movimientos.count({ where: { empresas_id: empresaId } }), eventosFondoAntesGasto);

        const anularGasto = await request("DELETE", `/api/caja/${movimientoCajaManualId}`, {
          routeKey: "/api/caja/:id",
          token: adminToken,
          body: { motivo: "Anulación controlada por suite" },
        });
        assertHttp(anularGasto, 200, "DELETE /api/caja/:id");

        const gastoAnulado = await prisma.movimientos_caja.findUnique({ where: { id: movimientoCajaManualId } });
        assert.equal(gastoAnulado.anulado, true);
        assert.equal(Number(gastoAnulado.monto), 9);
        assert.equal(await obtenerBalanceCajaSuite(), balanceAntesGasto, "La anulación debe restaurar el balance anterior de Caja.");
        assert.equal(await prisma.fondo_reposicion_movimientos.count({ where: { empresas_id: empresaId } }), eventosFondoAntesGasto);
      });

      const configServicio = await request("PUT", "/api/servicios-publicos/configuracion", {
        routeKey: "/api/servicios-publicos/configuracion",
        token: adminToken,
        body: { servicio: "energia", dia_pago: 15 },
      });
      assertHttp(configServicio, 200, "PUT /api/servicios-publicos/configuracion");

      const recibo = await request("POST", "/api/caja", {
        token: adminToken,
        body: {
          tipo: "gasto",
          categoria: "servicio_publico",
          tipo_servicio: "energia",
          periodo_servicio: PERIODO_COLOMBIA,
          monto: 15,
          descripcion: "Factura de energía temporal",
          fecha: FECHA_COLOMBIA,
        },
      });
      assertHttp(recibo, 201, "POST /api/caja factura de servicio público");

      traceSuite("CAJA CONCURRENCIA 00 - se programa subprueba hija");
      await testConDiagnostico(tCaja, "Recibos de servicio público duplicados concurrentemente: solo uno se registra", async () => {
          traceSuite("CAJA CONCURRENCIA 01 - antes configurar agua");
        const configurarAgua = await request("PUT", "/api/servicios-publicos/configuracion", {
          routeKey: "/api/servicios-publicos/configuracion",
          token: adminToken,
          body: { servicio: "agua", dia_pago: 20 },
        });
        assertHttp(configurarAgua, 200, "Configurar servicio de agua para prueba concurrente");
        traceSuite("CAJA CONCURRENCIA 02 - agua configurada");

        const filtroAgua = {
          empresas_id: empresaId,
          tipo: "gasto",
          categoria: "servicio_publico",
          tipo_servicio: "agua",
          periodo_servicio: PERIODO_COLOMBIA,
          anulado: false,
        };
        traceSuite("CAJA CONCURRENCIA 03 - antes count recibos agua");
        const recibosAntes = await prisma.movimientos_caja.count({ where: filtroAgua });
        traceSuite("CAJA CONCURRENCIA 04 - count recibos agua completado");

        traceSuite("CAJA CONCURRENCIA 05 - antes lanzar los dos POST concurrentes");
        const intentos = await Promise.allSettled([
          request("POST", "/api/caja", {
            routeKey: "/api/caja",
            token: adminToken,
            timeoutMs: 15_000,
            body: {
              tipo: "gasto",
              categoria: "servicio_publico",
              tipo_servicio: "agua",
              periodo_servicio: PERIODO_COLOMBIA,
              monto: 19,
              descripcion: "Recibo de agua concurrente A - suite",
              fecha: FECHA_COLOMBIA,
            },
          }),
          request("POST", "/api/caja", {
            routeKey: "/api/caja",
            token: adminToken,
            timeoutMs: 15_000,
            body: {
              tipo: "gasto",
              categoria: "servicio_publico",
              tipo_servicio: "agua",
              periodo_servicio: PERIODO_COLOMBIA,
              monto: 19,
              descripcion: "Recibo de agua concurrente B - suite",
              fecha: FECHA_COLOMBIA,
            },
          }),
        ]);
        traceSuite("CAJA CONCURRENCIA 06 - ambas promesas finalizaron");
        const erroresIntentos = intentos.filter((r) => r.status === "rejected");
        assert.equal(
          erroresIntentos.length,
          0,
          `Las solicitudes concurrentes de recibo no terminaron correctamente: ${erroresIntentos.map((r) => r.reason?.message).join(" | ")}`,
        );
        const [intentoA, intentoB] = intentos.map((r) => r.value);

        assert.deepEqual(
          [intentoA.status, intentoB.status].sort((a, b) => a - b),
          [201, 409],
          "Dos registros concurrentes del mismo servicio y periodo deben producir un único alta y un conflicto.",
        );

        traceSuite("CAJA CONCURRENCIA 07 - antes consultar recibos despues");
        const recibosDespues = await prisma.movimientos_caja.findMany({
          where: filtroAgua,
          orderBy: { id: "asc" },
          select: { id: true, monto: true, descripcion: true },
        });
        assert.equal(recibosDespues.length, recibosAntes + 1);
        assert.equal(Number(recibosDespues.at(-1).monto), 19);
        traceSuite("CAJA CONCURRENCIA 08 - prueba de recibos duplicados completada");
      });

      traceSuite("CAJA 30 - antes GET resumen servicios publicos");
      const resumenServicios = await request("GET", "/api/servicios-publicos", {
        routeKey: "/api/servicios-publicos",
        token: adminToken,
      });
      assertHttp(resumenServicios, 200, "GET /api/servicios-publicos");

      const fondo = await request("GET", "/api/caja/fondo-resumen", {
        routeKey: "/api/caja/fondo-resumen",
        token: adminToken,
      });
      assertHttp(fondo, 200, "GET /api/caja/fondo-resumen");

      traceSuite("CAJA 31 - antes POST reconstruir fondo");
      const reconstruir = await request("POST", "/api/caja/fondo-reconstruir", {
        routeKey: "/api/caja/fondo-reconstruir",
        token: adminToken,
      });
      assertHttp(reconstruir, 200, "POST /api/caja/fondo-reconstruir");

      traceSuite("CAJA 32 - antes snapshot fondo previo al rechazo empleado");
      const fondoAntesDeRechazoEmpleado = await prisma.fondo_reposicion_movimientos.findMany({
        where: { empresas_id: empresaId },
        orderBy: { id: "asc" },
        select: { id: true, monto: true, monto_solicitado: true, estado_calculo: true, anulado: true },
      });
      const empleadoSinPermiso = await request("POST", "/api/caja/fondo-reconstruir", {
        routeKey: "/api/caja/fondo-reconstruir",
        token: employeeToken,
      });
      assertHttp(empleadoSinPermiso, 403, "POST /api/caja/fondo-reconstruir con empleado");
      const fondoTrasRechazoEmpleado = await prisma.fondo_reposicion_movimientos.findMany({
        where: { empresas_id: empresaId },
        orderBy: { id: "asc" },
        select: { id: true, monto: true, monto_solicitado: true, estado_calculo: true, anulado: true },
      });
      const normalizarFondo = (filas) => filas.map((fila) => ({
        id: fila.id,
        monto: String(fila.monto),
        monto_solicitado: fila.monto_solicitado == null ? null : String(fila.monto_solicitado),
        estado_calculo: fila.estado_calculo,
        anulado: fila.anulado,
      }));
      assert.deepEqual(
        normalizarFondo(fondoTrasRechazoEmpleado),
        normalizarFondo(fondoAntesDeRechazoEmpleado),
        "Un empleado no debe poder modificar el Fondo al intentar reconstruirlo.",
      );
    });

    await testConDiagnostico(t, "Producción: crear, consultar, editar y anular lotes", async () => {
      const lista = await request("GET", "/api/produccion?page=1&limit=20", {
        routeKey: "/api/produccion",
        token: adminToken,
      });
      assertHttp(lista, 200, "GET /api/produccion");

      const lotesAntesDeReferenciaAjena = await prisma.lotes_produccion.count({ where: { empresas_id: empresaId } });
      const stockProductoAjenoAntesProduccion = await prisma.productos.findUnique({
        where: { id: productoAjenoId },
        select: { stock_actual: true },
      });
      const produccionConProductoAjeno = await request("POST", "/api/produccion", {
        routeKey: "/api/produccion",
        token: adminToken,
        body: {
          fecha: FECHA_COLOMBIA,
          notas: "Este lote no debe referenciar un producto de otra empresa",
          items: [{ productos_id: productoAjenoId, cantidad: 1, costo_total: 10 }],
        },
      });
      assertHttp(produccionConProductoAjeno, 400, "POST /api/produccion con producto de otra empresa");
      assert.equal(
        await prisma.lotes_produccion.count({ where: { empresas_id: empresaId } }),
        lotesAntesDeReferenciaAjena,
        "La producción con un producto ajeno no debe crear lotes.",
      );
      const stockProductoAjenoTrasProduccion = await prisma.productos.findUnique({
        where: { id: productoAjenoId },
        select: { stock_actual: true },
      });
      assert.equal(
        Number(stockProductoAjenoTrasProduccion.stock_actual),
        Number(stockProductoAjenoAntesProduccion.stock_actual),
      );

      const crearLote = await request("POST", "/api/produccion", {
        routeKey: "/api/produccion",
        token: adminToken,
        body: {
          fecha: FECHA_COLOMBIA,
          notas: "Lote temporal de prueba de creación y edición",
          items: [{ productos_id: productoId, cantidad: 2 }],
        },
      });
      assertHttp(crearLote, 201, "POST /api/produccion");
      loteAnuladoId = crearLote.json?.data?.id;
      assert.ok(loteAnuladoId);

      const detalle = await request("GET", `/api/produccion/${loteAnuladoId}`, {
        routeKey: "/api/produccion/:id",
        token: adminToken,
      });
      assertHttp(detalle, 200, "GET /api/produccion/:id");

      const editarLote = await request("PUT", `/api/produccion/${loteAnuladoId}`, {
        routeKey: "/api/produccion/:id",
        token: adminToken,
        body: {
          notas: "Lote temporal editado por suite",
          items: [{ productos_id: productoId, cantidad: 3 }],
        },
      });
      assertHttp(editarLote, 200, "PUT /api/produccion/:id");

      const anularLote = await request("DELETE", `/api/produccion/${loteAnuladoId}`, {
        routeKey: "/api/produccion/:id",
        token: adminToken,
        body: { motivo: "Anulación de lote temporal de suite" },
      });
      assertHttp(anularLote, 200, "DELETE /api/produccion/:id");

      const crearLoteVenta = await request("POST", "/api/produccion", {
        token: adminToken,
        body: {
          fecha: FECHA_COLOMBIA,
          notas: "Lote temporal para venta de integración",
          items: [{ productos_id: productoId, cantidad: 6 }],
        },
      });
      assertHttp(crearLoteVenta, 201, "Crear lote de producción para venta");
      loteActivoId = crearLoteVenta.json?.data?.id;
      assert.ok(loteActivoId);
    });

    await testConDiagnostico(t, "Clientes, saldos a favor y deudas de ventas", async (tClientes) => {
      const obtenerBalanceCajaVentas = async () => {
        const [ingresos, gastos] = await Promise.all([
          prisma.movimientos_caja.aggregate({
            where: { empresas_id: empresaId, anulado: false, tipo: "ingreso" },
            _sum: { monto: true },
          }),
          prisma.movimientos_caja.aggregate({
            where: { empresas_id: empresaId, anulado: false, tipo: "gasto" },
            _sum: { monto: true },
          }),
        ]);
        return Math.round((Number(ingresos._sum.monto ?? 0) - Number(gastos._sum.monto ?? 0)) * 100) / 100;
      };

      const crearCliente = await request("POST", "/api/clientes", {
        routeKey: "/api/clientes",
        token: adminToken,
        body: {
          nombre: `Cliente Suite ${entorno.runId}`,
          telefono: "3000000000",
          direccion: "Dirección temporal",
          notas: "Registro exclusivo de pruebas automatizadas",
        },
      });
      assertHttp(crearCliente, 201, "POST /api/clientes");
      clienteId = crearCliente.json?.data?.id;
      assert.ok(clienteId);

      const clientesLista = await request("GET", "/api/clientes", {
        routeKey: "/api/clientes",
        token: adminToken,
      });
      assertHttp(clientesLista, 200, "GET /api/clientes");

      const cliente = await request("GET", `/api/clientes/${clienteId}`, {
        routeKey: "/api/clientes/:id",
        token: adminToken,
      });
      assertHttp(cliente, 200, "GET /api/clientes/:id");

      const ventasAntesDeRechazos = await prisma.ventas.count({ where: { empresas_id: empresaId } });
      const stockProductoAntesDeRechazos = await prisma.productos.findUnique({
        where: { id: productoId },
        select: { stock_actual: true },
      });
      const stockProductoAjenoAntesDeRechazos = await prisma.productos.findUnique({
        where: { id: productoAjenoId },
        select: { stock_actual: true },
      });

      const ventaConClienteAjeno = await request("POST", "/api/ventas", {
        routeKey: "/api/ventas",
        token: adminToken,
        body: {
          fecha: FECHA_COLOMBIA,
          canal: "punto_venta",
          clientes_id: clienteAjenoId,
          credito: true,
          items: [{ productos_id: productoId, cantidad: 1, precio_unitario: 40 }],
        },
      });
      assertHttp(ventaConClienteAjeno, 400, "POST /api/ventas con cliente de otra empresa");

      const ventaConProductoAjeno = await request("POST", "/api/ventas", {
        routeKey: "/api/ventas",
        token: adminToken,
        body: {
          fecha: FECHA_COLOMBIA,
          canal: "punto_venta",
          clientes_id: clienteId,
          items: [{ productos_id: productoAjenoId, cantidad: 1, precio_unitario: 40 }],
        },
      });
      assertHttp(ventaConProductoAjeno, 400, "POST /api/ventas con producto de otra empresa");

      const ventaSinItems = await request("POST", "/api/ventas", {
        routeKey: "/api/ventas",
        token: adminToken,
        body: { fecha: FECHA_COLOMBIA, canal: "punto_venta", items: [] },
      });
      assertHttp(ventaSinItems, 400, "POST /api/ventas sin artículos");

      assert.equal(
        await prisma.ventas.count({ where: { empresas_id: empresaId } }),
        ventasAntesDeRechazos,
        "Las ventas rechazadas no deben crear encabezados de venta.",
      );
      const stockProductoTrasRechazos = await prisma.productos.findUnique({
        where: { id: productoId },
        select: { stock_actual: true },
      });
      const stockProductoAjenoTrasRechazos = await prisma.productos.findUnique({
        where: { id: productoAjenoId },
        select: { stock_actual: true },
      });
      assert.equal(Number(stockProductoTrasRechazos.stock_actual), Number(stockProductoAntesDeRechazos.stock_actual));
      assert.equal(Number(stockProductoAjenoTrasRechazos.stock_actual), Number(stockProductoAjenoAntesDeRechazos.stock_actual));

      const actualizarCliente = await request("PUT", `/api/clientes/${clienteId}`, {
        routeKey: "/api/clientes/:id",
        token: adminToken,
        body: { nombre: `Cliente Suite Actualizado ${entorno.runId}`, telefono: "3000000001" },
      });
      assertHttp(actualizarCliente, 200, "PUT /api/clientes/:id");

      const aviso = await request("PATCH", `/api/clientes/${clienteId}/aviso`, {
        routeKey: "/api/clientes/:id/aviso",
        token: adminToken,
        body: { enviado: true },
      });
      assertHttp(aviso, 200, "PATCH /api/clientes/:id/aviso");

      const inactivos = await request("GET", "/api/clientes/inactivos?dias=0", {
        routeKey: "/api/clientes/inactivos",
        token: adminToken,
      });
      assertHttp(inactivos, 200, "GET /api/clientes/inactivos");

      const saldoInicial = await request("GET", `/api/clientes/${clienteId}/saldo`, {
        routeKey: "/api/clientes/:id/saldo",
        token: adminToken,
      });
      assertHttp(saldoInicial, 200, "GET /api/clientes/:id/saldo");

      const deposito = await request("POST", `/api/clientes/${clienteId}/saldo`, {
        routeKey: "/api/clientes/:id/saldo",
        token: adminToken,
        body: { monto: 5, nota: "Depósito temporal de suite", fecha: FECHA_COLOMBIA, registrar_en_caja: false },
      });
      assertHttp(deposito, 201, "POST /api/clientes/:id/saldo");

      const devolucion = await request("POST", `/api/clientes/${clienteId}/saldo/devolucion`, {
        routeKey: "/api/clientes/:id/saldo/devolucion",
        token: adminToken,
        body: { monto: 5, nota: "Devolución temporal de suite", fecha: FECHA_COLOMBIA, registrar_en_caja: false },
      });
      assertHttp(devolucion, 201, "POST /api/clientes/:id/saldo/devolucion");

      const saldoCajaAntesVenta = await obtenerBalanceCajaVentas();
      const depositoParaVenta = await request("POST", `/api/clientes/${clienteId}/saldo`, {
        routeKey: "/api/clientes/:id/saldo",
        token: adminToken,
        body: { monto: 5, nota: "Saldo a favor para cubrir parcialmente una venta de suite", fecha: FECHA_COLOMBIA, registrar_en_caja: true },
      });
      assertHttp(depositoParaVenta, 201, "Registrar saldo a favor que se usará en la venta");
      assert.equal(Number(depositoParaVenta.json?.data?.saldo_favor), 5);
      assert.equal(await obtenerBalanceCajaVentas(), Math.round((saldoCajaAntesVenta + 5) * 100) / 100);

      const productoStockAntesVenta = await prisma.productos.findUnique({
        where: { id: productoId },
        select: { stock_actual: true },
      });
      const stockAntesVenta = Number(productoStockAntesVenta.stock_actual);

      const venta = await request("POST", "/api/ventas", {
        routeKey: "/api/ventas",
        token: adminToken,
        body: {
          fecha: FECHA_COLOMBIA,
          canal: "punto_venta",
          clientes_id: clienteId,
          credito: true,
          abono_inicial: 0,
          saldo_usado: 5,
          items: [{ productos_id: productoId, cantidad: 1, precio_unitario: 40 }],
        },
      });
      assertHttp(venta, 201, "POST /api/ventas");
      ventaId = venta.json?.data?.id;
      assert.ok(ventaId);
      const clienteTrasUsarSaldo = await prisma.clientes.findUnique({
        where: { id: clienteId },
        select: { saldo_favor: true },
      });
      const usoSaldoVenta = await prisma.saldos_cliente.findFirst({
        where: { empresas_id: empresaId, clientes_id: clienteId, ventas_id: ventaId, tipo: "uso" },
      });
      assert.equal(Number(clienteTrasUsarSaldo.saldo_favor), 0);
      assert.ok(usoSaldoVenta);
      assert.equal(Number(usoSaldoVenta.monto), 5);

      const ventaAntesDePermisosEmpleado = await prisma.ventas.findUnique({
        where: { id: ventaId },
        include: { ventas_items: true },
      });
      const stockAntesDePermisosEmpleado = await prisma.productos.findUnique({
        where: { id: productoId },
        select: { stock_actual: true },
      });

      const editarVentaEmpleado = await request("PUT", `/api/ventas/${ventaId}`, {
        routeKey: "/api/ventas/:id",
        token: employeeToken,
        body: {
          items: [{ productos_id: productoId, cantidad: 3, precio_unitario: 1 }],
          notas: "El empleado no debe editar esta venta",
        },
      });
      assertHttp(editarVentaEmpleado, 403, "PUT /api/ventas/:id con rol empleado");

      const anularVentaEmpleado = await request("DELETE", `/api/ventas/${ventaId}`, {
        routeKey: "/api/ventas/:id",
        token: employeeToken,
        body: { motivo: "El empleado no debe anular esta venta" },
      });
      assertHttp(anularVentaEmpleado, 403, "DELETE /api/ventas/:id con rol empleado");

      const ventaTrasPermisosEmpleado = await prisma.ventas.findUnique({
        where: { id: ventaId },
        include: { ventas_items: true },
      });
      const stockTrasPermisosEmpleado = await prisma.productos.findUnique({
        where: { id: productoId },
        select: { stock_actual: true },
      });
      assert.equal(ventaTrasPermisosEmpleado.anulada, ventaAntesDePermisosEmpleado.anulada);
      assert.equal(Number(ventaTrasPermisosEmpleado.total), Number(ventaAntesDePermisosEmpleado.total));
      assert.deepEqual(
        ventaTrasPermisosEmpleado.ventas_items.map((item) => [item.productos_id, Number(item.cantidad), Number(item.precio_unitario)]),
        ventaAntesDePermisosEmpleado.ventas_items.map((item) => [item.productos_id, Number(item.cantidad), Number(item.precio_unitario)]),
      );
      assert.equal(Number(stockTrasPermisosEmpleado.stock_actual), Number(stockAntesDePermisosEmpleado.stock_actual));

      const ventasLista = await request("GET", "/api/ventas?page=1&limit=20", {
        routeKey: "/api/ventas",
        token: adminToken,
      });
      assertHttp(ventasLista, 200, "GET /api/ventas");

      const ventaDetalle = await request("GET", `/api/ventas/${ventaId}`, {
        routeKey: "/api/ventas/:id",
        token: adminToken,
      });
      assertHttp(ventaDetalle, 200, "GET /api/ventas/:id");

      const recalcularCosto = await request("POST", `/api/ventas/${ventaId}/recalcular-costo-historico`, {
        routeKey: "/api/ventas/:id/recalcular-costo-historico",
        token: adminToken,
      });
      assertHttp(recalcularCosto, 200, "POST /api/ventas/:id/recalcular-costo-historico");

      const editarVenta = await request("PUT", `/api/ventas/${ventaId}`, {
        routeKey: "/api/ventas/:id",
        token: adminToken,
        body: { items: [{ productos_id: productoId, cantidad: 2, precio_unitario: 40 }], notas: "Venta actualizada por suite" },
      });
      assertHttp(editarVenta, 200, "PUT /api/ventas/:id");

      await testConDiagnostico(tClientes, "Rollback atómico de venta cuando líneas repetidas agotan el stock", async () => {
        const productoAntes = await prisma.productos.findUnique({
          where: { id: productoId },
          select: { stock_actual: true },
        });
        const stockAntes = Number(productoAntes.stock_actual);
        const cantidadPorLinea = Math.floor(stockAntes);
        assert.ok(cantidadPorLinea > 0, `Se necesita stock positivo para probar rollback; stock actual: ${stockAntes}`);

        const [ventasAntes, itemsAntes, cajaAntes, pagosAntes, fondoAntes] = await Promise.all([
          prisma.ventas.count({ where: { empresas_id: empresaId } }),
          prisma.ventas_items.count({ where: { ventas: { empresas_id: empresaId } } }),
          prisma.movimientos_caja.count({ where: { empresas_id: empresaId } }),
          prisma.pagos_venta.count({ where: { ventas: { empresas_id: empresaId } } }),
          prisma.fondo_reposicion_movimientos.count({ where: { empresas_id: empresaId } }),
        ]);

        const ventaSinStockSuficiente = await request("POST", "/api/ventas", {
          routeKey: "/api/ventas",
          token: adminToken,
          body: {
            fecha: FECHA_COLOMBIA,
            canal: "punto_venta",
            clientes_id: clienteId,
            credito: true,
            items: [
              { productos_id: productoId, cantidad: cantidadPorLinea, precio_unitario: 1 },
              { productos_id: productoId, cantidad: cantidadPorLinea, precio_unitario: 1 },
            ],
          },
        });
        assertHttp(ventaSinStockSuficiente, 400, "Venta con líneas repetidas que exceden el stock total");

        const [ventasDespues, itemsDespues, cajaDespues, pagosDespues, fondoDespues, productoDespues] = await Promise.all([
          prisma.ventas.count({ where: { empresas_id: empresaId } }),
          prisma.ventas_items.count({ where: { ventas: { empresas_id: empresaId } } }),
          prisma.movimientos_caja.count({ where: { empresas_id: empresaId } }),
          prisma.pagos_venta.count({ where: { ventas: { empresas_id: empresaId } } }),
          prisma.fondo_reposicion_movimientos.count({ where: { empresas_id: empresaId } }),
          prisma.productos.findUnique({ where: { id: productoId }, select: { stock_actual: true } }),
        ]);

        assert.equal(ventasDespues, ventasAntes, "El encabezado de venta debe revertirse cuando falla la validación final de stock.");
        assert.equal(itemsDespues, itemsAntes, "Las líneas de la venta fallida no deben persistir.");
        assert.equal(cajaDespues, cajaAntes, "El rollback no debe dejar movimientos de Caja.");
        assert.equal(pagosDespues, pagosAntes, "El rollback no debe dejar pagos.");
        assert.equal(fondoDespues, fondoAntes, "El rollback no debe dejar eventos en el Fondo.");
        assert.equal(Number(productoDespues.stock_actual), stockAntes, "El stock debe recuperar su valor exacto anterior.");
      });

      const deudas = await request("GET", "/api/deudas?page=1&limit=20", {
        routeKey: "/api/deudas",
        token: adminToken,
      });
      assertHttp(deudas, 200, "GET /api/deudas");

      const resumenDeudas = await request("GET", "/api/deudas/resumen", {
        routeKey: "/api/deudas/resumen",
        token: adminToken,
      });
      assertHttp(resumenDeudas, 200, "GET /api/deudas/resumen");

      await testConDiagnostico(tClientes, "Abonos concurrentes no duplican pagos, Caja ni recuperaciones del Fondo", async () => {
        const ventaAntes = await prisma.ventas.findUnique({
          where: { id: ventaId },
          include: { pagos_venta: true },
        });
        const totalPagadoAntes = ventaAntes.pagos_venta.reduce((s, pago) => s + Number(pago.monto), 0);
        const saldoAntes = Number(ventaAntes.total) - totalPagadoAntes;
        assert.ok(saldoAntes > 2, `Se necesita una deuda pendiente suficiente; saldo actual: ${saldoAntes}`);

        // Cada solicitud supera la mitad del saldo: solo una puede confirmarse sin sobrepasarlo.
        const montoDuplicado = Math.min(saldoAntes, Math.ceil(saldoAntes / 2) + 1);
        assert.ok(montoDuplicado <= saldoAntes && montoDuplicado * 2 > saldoAntes);

        const [pagosAntes, cajaAntes, fondoAntes] = await Promise.all([
          prisma.pagos_venta.findMany({ where: { ventas_id: ventaId }, select: { id: true, monto: true } }),
          prisma.movimientos_caja.findMany({
            where: { empresas_id: empresaId, ventas_id: ventaId, tipo: "ingreso", categoria: "venta", anulado: false },
            select: { id: true, monto: true },
          }),
          prisma.fondo_reposicion_movimientos.findMany({
            where: { empresas_id: empresaId, venta_id: ventaId, tipo: "recuperacion", anulado: false },
            select: { id: true, monto_cobrado: true, pago_venta_id: true },
          }),
        ]);

        const intentosAbono = await Promise.allSettled([
          request("POST", `/api/deudas/${ventaId}/pagos`, {
            routeKey: "/api/deudas/:ventaId/pagos",
            token: adminToken,
            timeoutMs: 15_000,
            body: { monto: montoDuplicado, nota: "Intento concurrente A - suite", fecha: FECHA_COLOMBIA },
          }),
          request("POST", `/api/deudas/${ventaId}/pagos`, {
            routeKey: "/api/deudas/:ventaId/pagos",
            token: adminToken,
            timeoutMs: 15_000,
            body: { monto: montoDuplicado, nota: "Intento concurrente B - suite", fecha: FECHA_COLOMBIA },
          }),
        ]);
        const erroresAbono = intentosAbono.filter((r) => r.status === "rejected");
        assert.equal(
          erroresAbono.length,
          0,
          `Las solicitudes concurrentes de abono no terminaron correctamente: ${erroresAbono.map((r) => r.reason?.message).join(" | ")}`,
        );
        const [abonoA, abonoB] = intentosAbono.map((r) => r.value);

        assert.deepEqual(
          [abonoA.status, abonoB.status].sort((a, b) => a - b),
          [201, 400],
          "Dos abonos concurrentes que juntos superan el saldo deben dejar solo uno registrado.",
        );

        const [ventaDespues, pagosDespues, cajaDespues, fondoDespues] = await Promise.all([
          prisma.ventas.findUnique({ where: { id: ventaId }, include: { pagos_venta: true } }),
          prisma.pagos_venta.findMany({ where: { ventas_id: ventaId }, select: { id: true, monto: true } }),
          prisma.movimientos_caja.findMany({
            where: { empresas_id: empresaId, ventas_id: ventaId, tipo: "ingreso", categoria: "venta", anulado: false },
            select: { id: true, monto: true },
          }),
          prisma.fondo_reposicion_movimientos.findMany({
            where: { empresas_id: empresaId, venta_id: ventaId, tipo: "recuperacion", anulado: false },
            select: { id: true, monto_cobrado: true, pago_venta_id: true },
          }),
        ]);

        const sumar = (filas, campo) => filas.reduce((s, fila) => s + Number(fila[campo] ?? 0), 0);
        assert.equal(pagosDespues.length, pagosAntes.length + 1, "Debe existir exactamente un pago nuevo.");
        assert.equal(Number((sumar(pagosDespues, "monto") - sumar(pagosAntes, "monto")).toFixed(2)), montoDuplicado);
        assert.equal(cajaDespues.length, cajaAntes.length + 1, "Debe existir exactamente un ingreso nuevo en Caja.");
        assert.equal(Number((sumar(cajaDespues, "monto") - sumar(cajaAntes, "monto")).toFixed(2)), montoDuplicado);
        assert.equal(fondoDespues.length, fondoAntes.length + 1, "Debe existir exactamente una recuperación nueva en el Fondo.");
        assert.equal(Number((sumar(fondoDespues, "monto_cobrado") - sumar(fondoAntes, "monto_cobrado")).toFixed(2)), montoDuplicado);

        const pagoNuevo = pagosDespues.find((pago) => !pagosAntes.some((anterior) => anterior.id === pago.id));
        assert.ok(pagoNuevo, "Debe identificarse el único pago generado por la operación concurrente.");
        assert.ok(
          fondoDespues.some((evento) => evento.pago_venta_id === pagoNuevo.id),
          "La recuperación del Fondo debe quedar vinculada al pago confirmado.",
        );
        assert.equal(ventaDespues.estado_pago, "parcial");
        assert.equal(Number((Number(ventaDespues.total) - sumar(pagosDespues, "monto")).toFixed(2)), Number((saldoAntes - montoDuplicado).toFixed(2)));
      });

      const pagoVenta = await request("POST", `/api/deudas/${ventaId}/pagos`, {
        routeKey: "/api/deudas/:ventaId/pagos",
        token: adminToken,
        body: { monto: 5, nota: "Abono individual de suite", fecha: FECHA_COLOMBIA },
      });
      assertHttp(pagoVenta, 201, "POST /api/deudas/:ventaId/pagos");

      const deudasPorCliente = await request("GET", "/api/deudas/clientes", {
        routeKey: "/api/deudas/clientes",
        token: adminToken,
      });
      assertHttp(deudasPorCliente, 200, "GET /api/deudas/clientes");

      const detalleDeudaCliente = await request("GET", `/api/deudas/clientes/${clienteId}`, {
        routeKey: "/api/deudas/clientes/:clientesId",
        token: adminToken,
      });
      assertHttp(detalleDeudaCliente, 200, "GET /api/deudas/clientes/:clientesId");

      const pagoGeneral = await request("POST", `/api/deudas/clientes/${clienteId}/pagos`, {
        routeKey: "/api/deudas/clientes/:clientesId/pagos",
        token: adminToken,
        body: { monto: 5, nota: "Abono general de suite", fecha: FECHA_COLOMBIA },
      });
      assertHttp(pagoGeneral, 201, "POST /api/deudas/clientes/:clientesId/pagos");

      await testConDiagnostico(tClientes, "Editar venta con abonos conserva pagos y recalcula Fondo; total menor a lo recibido se rechaza", async () => {
        const ventaAntes = await prisma.ventas.findUnique({
          where: { id: ventaId },
          include: { ventas_items: true, pagos_venta: true },
        });
        assert.equal(ventaAntes.ventas_items.length, 1, "El escenario requiere una línea de venta controlada.");
        const montoPagadoAntes = ventaAntes.pagos_venta.reduce((sum, pago) => sum + Number(pago.monto), 0);
        assert.ok(montoPagadoAntes > 0 && montoPagadoAntes < Number(ventaAntes.total));

        const pagosAntes = await prisma.pagos_venta.findMany({
          where: { ventas_id: ventaId },
          select: { id: true, monto: true, fecha: true, nota: true },
          orderBy: { id: "asc" },
        });
        const cajaAntes = await prisma.movimientos_caja.findMany({
          where: { ventas_id: ventaId, tipo: "ingreso", categoria: "venta" },
          select: { id: true, monto: true, anulado: true },
          orderBy: { id: "asc" },
        });
        const fondoAntes = await prisma.fondo_reposicion_movimientos.findMany({
          where: { venta_id: ventaId, tipo: "recuperacion" },
          select: { id: true, monto: true, monto_cobrado: true, pago_venta_id: true, anulado: true },
          orderBy: { id: "asc" },
        });
        const stockAntesEdicion = Number((await prisma.productos.findUnique({
          where: { id: productoId },
          select: { stock_actual: true },
        })).stock_actual);

        const nuevoTotal = Math.round((Number(ventaAntes.total) + 10) * 100) / 100;
        const cantidadActual = Number(ventaAntes.ventas_items[0].cantidad);
        const nuevoPrecioUnitario = nuevoTotal / cantidadActual;
        const editarVentaConAbonos = await request("PUT", `/api/ventas/${ventaId}`, {
          routeKey: "/api/ventas/:id",
          token: adminToken,
          body: {
            items: [{ productos_id: productoId, cantidad: cantidadActual, precio_unitario: nuevoPrecioUnitario }],
            notas: "Edición financiera posterior a abonos - suite",
          },
        });
        assertHttp(editarVentaConAbonos, 200, "PUT venta con abonos existentes");

        const ventaEditada = await prisma.ventas.findUnique({
          where: { id: ventaId },
          include: { ventas_items: true, pagos_venta: true },
        });
        const pagosTrasEdicion = await prisma.pagos_venta.findMany({
          where: { ventas_id: ventaId },
          select: { id: true, monto: true, fecha: true, nota: true },
          orderBy: { id: "asc" },
        });
        const cajaTrasEdicion = await prisma.movimientos_caja.findMany({
          where: { ventas_id: ventaId, tipo: "ingreso", categoria: "venta" },
          select: { id: true, monto: true, anulado: true },
          orderBy: { id: "asc" },
        });
        const fondoTrasEdicion = await prisma.fondo_reposicion_movimientos.findMany({
          where: { venta_id: ventaId, tipo: "recuperacion" },
          select: { id: true, monto: true, monto_cobrado: true, pago_venta_id: true, anulado: true },
          orderBy: { id: "asc" },
        });
        const stockTrasEdicion = Number((await prisma.productos.findUnique({
          where: { id: productoId },
          select: { stock_actual: true },
        })).stock_actual);

        const redondear = (valor) => Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
        const totalPagadoTrasEdicion = pagosTrasEdicion.reduce((sum, pago) => sum + Number(pago.monto), 0);
        const costoTotalEditado = redondear(ventaEditada.ventas_items.reduce((sum, item) => (
          sum + (item.costo_unitario == null ? 0 : Number(item.costo_unitario) * Number(item.cantidad))
        ), 0));

        assert.equal(Number(ventaEditada.total), nuevoTotal);
        assert.equal(ventaEditada.estado_pago, "parcial");
        assert.equal(ventaEditada.notas, "Edición financiera posterior a abonos - suite");
        assert.equal(redondear(totalPagadoTrasEdicion), redondear(montoPagadoAntes), "Editar la venta no debe cambiar el dinero ya recibido.");
        const normalizarPagos = (filas) => filas.map(pago => [pago.id, Number(pago.monto), pago.fecha.toISOString(), pago.nota]);
        const normalizarCajaVenta = (filas) => filas.map(movimiento => [movimiento.id, Number(movimiento.monto), movimiento.anulado]);
        assert.deepEqual(normalizarPagos(pagosTrasEdicion), normalizarPagos(pagosAntes), "Editar no debe crear, borrar ni duplicar pagos.");
        assert.deepEqual(normalizarCajaVenta(cajaTrasEdicion), normalizarCajaVenta(cajaAntes), "Editar no debe crear ni alterar ingresos históricos de Caja.");
        assert.equal(fondoTrasEdicion.length, fondoAntes.length, "Editar no debe duplicar recuperaciones del Fondo.");
        for (let index = 0; index < fondoTrasEdicion.length; index += 1) {
          const actual = fondoTrasEdicion[index];
          const anterior = fondoAntes[index];
          assert.equal(actual.id, anterior.id);
          assert.equal(Number(actual.monto_cobrado), Number(anterior.monto_cobrado));
          assert.equal(actual.pago_venta_id, anterior.pago_venta_id);
          assert.equal(actual.anulado, anterior.anulado);
          const esperado = redondear(costoTotalEditado * Math.min(Number(actual.monto_cobrado ?? 0) / nuevoTotal, 1));
          assert.equal(Number(actual.monto), esperado, "El Fondo debe recalcular la recuperación con el nuevo total de la venta.");
        }
        assert.equal(stockTrasEdicion, stockAntesEdicion, "Editar la misma cantidad no debe cambiar el stock neto.");
        assert.equal(redondear(Number(ventaEditada.total) - totalPagadoTrasEdicion), redondear(nuevoTotal - montoPagadoAntes));

        const totalMenorALoRecibido = redondear(montoPagadoAntes - 1);
        assert.ok(totalMenorALoRecibido > 0 && totalMenorALoRecibido < montoPagadoAntes);
        const rechazarTotalMenor = await request("PUT", `/api/ventas/${ventaId}`, {
          routeKey: "/api/ventas/:id",
          token: adminToken,
          body: {
            items: [{ productos_id: productoId, cantidad: 1, precio_unitario: totalMenorALoRecibido }],
            notas: "Esta reducción no debe persistir porque ya se recibió más dinero",
          },
        });
        assertHttp(rechazarTotalMenor, 400, "PUT venta con total inferior a lo ya recibido");

        const ventaTrasRechazo = await prisma.ventas.findUnique({
          where: { id: ventaId },
          include: { ventas_items: true },
        });
        const pagosTrasRechazo = await prisma.pagos_venta.findMany({
          where: { ventas_id: ventaId },
          select: { id: true, monto: true, fecha: true, nota: true },
          orderBy: { id: "asc" },
        });
        const cajaTrasRechazo = await prisma.movimientos_caja.findMany({
          where: { ventas_id: ventaId, tipo: "ingreso", categoria: "venta" },
          select: { id: true, monto: true, anulado: true },
          orderBy: { id: "asc" },
        });
        const fondoTrasRechazo = await prisma.fondo_reposicion_movimientos.findMany({
          where: { venta_id: ventaId, tipo: "recuperacion" },
          select: { id: true, monto: true, monto_cobrado: true, pago_venta_id: true, anulado: true },
          orderBy: { id: "asc" },
        });
        const stockTrasRechazo = Number((await prisma.productos.findUnique({
          where: { id: productoId },
          select: { stock_actual: true },
        })).stock_actual);

        assert.equal(Number(ventaTrasRechazo.total), nuevoTotal);
        assert.equal(ventaTrasRechazo.estado_pago, "parcial");
        assert.equal(ventaTrasRechazo.notas, "Edición financiera posterior a abonos - suite");
        assert.deepEqual(
          ventaTrasRechazo.ventas_items.map(item => [item.id, item.productos_id, item.cantidad, Number(item.precio_unitario), Number(item.subtotal)]),
          ventaEditada.ventas_items.map(item => [item.id, item.productos_id, item.cantidad, Number(item.precio_unitario), Number(item.subtotal)]),
        );
        assert.deepEqual(normalizarPagos(pagosTrasRechazo), normalizarPagos(pagosAntes));
        assert.deepEqual(normalizarCajaVenta(cajaTrasRechazo), normalizarCajaVenta(cajaAntes));
        assert.deepEqual(
          fondoTrasRechazo.map(evento => [evento.id, Number(evento.monto), Number(evento.monto_cobrado), evento.pago_venta_id, evento.anulado]),
          fondoTrasEdicion.map(evento => [evento.id, Number(evento.monto), Number(evento.monto_cobrado), evento.pago_venta_id, evento.anulado]),
        );
        assert.equal(stockTrasRechazo, stockAntesEdicion, "La edición rechazada no debe tocar el inventario.");
      });

      await testConDiagnostico(tClientes, "Anulación de venta liquida Caja y Fondo y restaura inventario sin borrar pagos históricos", async () => {
        const ventaAntesAnulacion = await prisma.ventas.findUnique({
          where: { id: ventaId },
          include: { ventas_items: true },
        });
        const pagosAntesAnulacion = await prisma.pagos_venta.findMany({
          where: { ventas_id: ventaId },
          select: { id: true, monto: true, fecha: true, nota: true },
          orderBy: { id: "asc" },
        });
        const cajaAntesAnulacion = await prisma.movimientos_caja.findMany({
          where: { ventas_id: ventaId, tipo: "ingreso", categoria: "venta" },
          select: { id: true, monto: true, anulado: true },
          orderBy: { id: "asc" },
        });
        const fondoAntesAnulacion = await prisma.fondo_reposicion_movimientos.findMany({
          where: { venta_id: ventaId, tipo: "recuperacion" },
          select: { id: true, monto: true, monto_cobrado: true, pago_venta_id: true, anulado: true },
          orderBy: { id: "asc" },
        });
        const stockAntesAnulacion = Number((await prisma.productos.findUnique({
          where: { id: productoId },
          select: { stock_actual: true },
        })).stock_actual);
        const balanceCajaAntesAnulacion = await obtenerBalanceCajaVentas();
        const ingresosQueSeAnulan = cajaAntesAnulacion
          .filter(movimiento => !movimiento.anulado)
          .reduce((sum, movimiento) => sum + Number(movimiento.monto), 0);
        const cantidadVendida = ventaAntesAnulacion.ventas_items.reduce((sum, item) => sum + Number(item.cantidad), 0);

        const anularVenta = await request("DELETE", `/api/ventas/${ventaId}`, {
          routeKey: "/api/ventas/:id",
          token: adminToken,
          body: { motivo: "Anulación de venta temporal de suite" },
        });
        assertHttp(anularVenta, 200, "DELETE /api/ventas/:id");

        const ventaAnulada = await prisma.ventas.findUnique({ where: { id: ventaId } });
        const pagosTrasAnulacion = await prisma.pagos_venta.findMany({
          where: { ventas_id: ventaId },
          select: { id: true, monto: true, fecha: true, nota: true },
          orderBy: { id: "asc" },
        });
        const cajaTrasAnulacion = await prisma.movimientos_caja.findMany({
          where: { ventas_id: ventaId, tipo: "ingreso", categoria: "venta" },
          select: { id: true, monto: true, anulado: true },
          orderBy: { id: "asc" },
        });
        const fondoTrasAnulacion = await prisma.fondo_reposicion_movimientos.findMany({
          where: { venta_id: ventaId, tipo: "recuperacion" },
          select: { id: true, monto: true, monto_cobrado: true, pago_venta_id: true, anulado: true },
          orderBy: { id: "asc" },
        });
        const stockTrasAnulacion = Number((await prisma.productos.findUnique({
          where: { id: productoId },
          select: { stock_actual: true },
        })).stock_actual);
        const balanceCajaTrasAnulacion = await obtenerBalanceCajaVentas();

        assert.equal(ventaAnulada.anulada, true);
        assert.equal(ventaAnulada.motivo_anulacion, "Anulación de venta temporal de suite");
        assert.deepEqual(
          pagosTrasAnulacion.map(pago => [pago.id, Number(pago.monto), pago.fecha.toISOString(), pago.nota]),
          pagosAntesAnulacion.map(pago => [pago.id, Number(pago.monto), pago.fecha.toISOString(), pago.nota]),
          "Anular la venta debe preservar el historial de pagos.",
        );
        assert.equal(cajaTrasAnulacion.length, cajaAntesAnulacion.length);
        assert.ok(cajaTrasAnulacion.every(movimiento => movimiento.anulado), "Todos los ingresos asociados a la venta deben quedar anulados.");
        assert.deepEqual(
          cajaTrasAnulacion.map(movimiento => [movimiento.id, Number(movimiento.monto)]),
          cajaAntesAnulacion.map(movimiento => [movimiento.id, Number(movimiento.monto)]),
        );
        assert.equal(fondoTrasAnulacion.length, fondoAntesAnulacion.length);
        assert.ok(fondoTrasAnulacion.every(evento => evento.anulado), "Todas las recuperaciones de esa venta deben quedar anuladas.");
        assert.deepEqual(
          fondoTrasAnulacion.map(evento => [evento.id, Number(evento.monto_cobrado), evento.pago_venta_id]),
          fondoAntesAnulacion.map(evento => [evento.id, Number(evento.monto_cobrado), evento.pago_venta_id]),
        );
        assert.equal(stockTrasAnulacion, stockAntesAnulacion + cantidadVendida, "Anular la venta debe restaurar todas las unidades vendidas.");
        assert.equal(stockTrasAnulacion, stockAntesVenta, "El stock debe regresar exactamente al nivel previo a registrar la venta.");
        assert.equal(
          balanceCajaTrasAnulacion,
          Math.round((balanceCajaAntesAnulacion - ingresosQueSeAnulan) * 100) / 100,
          "El balance de Caja debe excluir todos los ingresos anulados de la venta.",
        );
        assert.equal(await prisma.ventas.count({ where: { id: ventaId, anulada: false } }), 0);
        const clienteSaldoTrasAnulacion = await prisma.clientes.findUnique({
          where: { id: clienteId },
          select: { saldo_favor: true },
        });
        assert.equal(Number(clienteSaldoTrasAnulacion.saldo_favor), 5, "Anular la venta debe reintegrar al cliente el saldo a favor utilizado.");
      });

      const balanceAntesDevolucionSaldoReintegrado = await obtenerBalanceCajaVentas();
      const devolucionSaldoReintegrado = await request("POST", `/api/clientes/${clienteId}/saldo/devolucion`, {
        routeKey: "/api/clientes/:id/saldo/devolucion",
        token: adminToken,
        body: { monto: 5, nota: "Devolución del saldo reintegrado tras anular la venta", fecha: FECHA_COLOMBIA, registrar_en_caja: true },
      });
      assertHttp(devolucionSaldoReintegrado, 201, "Devolver el saldo reintegrado después de anular la venta");
      assert.equal(Number(devolucionSaldoReintegrado.json?.data?.saldo_favor), 0);
      assert.equal(await obtenerBalanceCajaVentas(), Math.round((balanceAntesDevolucionSaldoReintegrado - 5) * 100) / 100);

      const eliminarCliente = await request("DELETE", `/api/clientes/${clienteId}`, {
        routeKey: "/api/clientes/:id",
        token: adminToken,
      });
      assertHttp(eliminarCliente, 200, "DELETE /api/clientes/:id");
    });

    await testConDiagnostico(t, "Caja, reportes y catálogo público: consultas finales", async () => {
      const cajaLista = await request("GET", "/api/caja?periodo=total&page=1&limit=50", {
        routeKey: "/api/caja",
        token: adminToken,
      });
      assertHttp(cajaLista, 200, "GET /api/caja");

      const cajaResumen = await request("GET", "/api/caja/resumen?periodo=total", {
        routeKey: "/api/caja/resumen",
        token: adminToken,
      });
      assertHttp(cajaResumen, 200, "GET /api/caja/resumen");

      const disponible = await request("GET", "/api/caja/disponible-resumen", {
        routeKey: "/api/caja/disponible-resumen",
        token: adminToken,
      });
      assertHttp(disponible, 200, "GET /api/caja/disponible-resumen");

      const rentabilidad = await request("GET", "/api/reportes/rentabilidad?periodo=total", {
        routeKey: "/api/reportes/rentabilidad",
        token: adminToken,
      });
      assertHttp(rentabilidad, 200, "GET /api/reportes/rentabilidad");

      const primerRegistro = await request("GET", "/api/reportes/primer-registro?modulo=ventas", {
        routeKey: "/api/reportes/primer-registro",
        token: adminToken,
      });
      assertHttp(primerRegistro, 200, "GET /api/reportes/primer-registro");

      const historialProducto = await request("GET", `/api/productos/${productoId}/historial?page=1&limit=20`, {
        routeKey: "/api/productos/:id/historial",
        token: adminToken,
      });
      assertHttp(historialProducto, 200, "GET /api/productos/:id/historial");

      const publicEmpresa = await request("GET", "/api/public/empresa", {
        routeKey: "/api/public/empresa",
      });
      assertHttp(publicEmpresa, 200, "GET /api/public/empresa");
      assert.equal(publicEmpresa.json?.data?.id, empresaId);

      const publicProductos = await request("GET", "/api/public/productos", {
        routeKey: "/api/public/productos",
      });
      assertHttp(publicProductos, 200, "GET /api/public/productos");
      assert.ok(publicProductos.json?.data?.some((item) => item.id === productoId));

      const eliminarProducto = await request("DELETE", `/api/productos/${productoId}`, {
        routeKey: "/api/productos/:id",
        token: adminToken,
      });
      assertHttp(eliminarProducto, 200, "DELETE /api/productos/:id");

      const eliminarInsumo = await request("DELETE", `/api/insumos/${insumoId}`, {
        routeKey: "/api/insumos/:id",
        token: adminToken,
      });
      assertHttp(eliminarInsumo, 200, "DELETE /api/insumos/:id");
    });

    await testConDiagnostico(t, "Cobertura declarada de endpoints", async () => {
      const faltantes = EXPECTED_ENDPOINTS.filter((endpoint) => !cobertura.has(endpoint));
      assert.deepEqual(faltantes, [], `Quedaron endpoints sin ejecutar: ${faltantes.join(", ")}`);
      assert.equal(EXPECTED_ENDPOINTS.length, 76, "El inventario esperado contiene 75 endpoints de módulo más /health.");
    });
  } finally {
    traceSuite("Iniciando limpieza de fixtures temporales");
    try {
      await limpiarEntornoPruebas(entorno);
    } finally {
      traceSuite("Limpieza finalizada");
      detenerWatchdog?.();
    }
  }
});
