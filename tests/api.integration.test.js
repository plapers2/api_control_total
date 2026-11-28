import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../src/db/prisma.js";
import {
  EXPECTED_ENDPOINTS,
  FECHA_COLOMBIA,
  PERIODO_COLOMBIA,
  assertHttp,
  crearClienteApi,
  crearEntornoPruebas,
  limpiarEntornoPruebas,
} from "./helpers/runtime.js";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p5sAAAAASUVORK5CYII=";

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
  const cobertura = new Set();

  try {
    entorno = await crearEntornoPruebas();
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

    await t.test("Health check y autenticación", async () => {
      const health = await request("GET", "/health", { routeKey: "/health" });
      assertHttp(health, 200, "GET /health");
      assert.equal(health.json?.status, "ok");

      const sinToken = await request("GET", "/api/auth/me");
      assertHttp(sinToken, 401, "GET /api/auth/me sin token");

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
        token: employeeToken,
        body: { nombre: "No debe crearse", precio_venta: 1 },
      });
      assertHttp(empleadoSinPermiso, 403, "POST /api/productos con empleado");
    });

    await t.test("Empresas, membresías y superadministración", async () => {
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

      const accesoOtraEmpresa = await request("GET", `/api/empresas/${empresaSecundariaId}`, {
        routeKey: "/api/empresas/:id",
        token: adminToken,
      });
      assertHttp(accesoOtraEmpresa, 403, "GET /api/empresas/:id de otra empresa");

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

      const cambiarPassword = await request("POST", "/api/auth/cambiar-password", {
        routeKey: "/api/auth/cambiar-password",
        token: pendingToken,
        body: { password_actual: passwordTemporal, password_nuevo: `Nueva-${entorno.runId}-Clave!` },
      });
      assertHttp(cambiarPassword, 200, "POST /api/auth/cambiar-password");

      const perfilDesbloqueado = await request("GET", "/api/auth/me", { token: pendingToken });
      assertHttp(perfilDesbloqueado, 200, "GET /api/auth/me después de cambiar contraseña");
    });

    await t.test("Productos e insumos: alta, ajustes, conciliación y receta", async () => {
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

    await t.test("Caja, compras, recuperación histórica y servicios públicos", async () => {
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
      const movimientoHistoricoId = await crearCompraHistorica(entorno, insumoHistoricoId);

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

      const gasto = await request("POST", "/api/caja", {
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

      const actualizarGasto = await request("PUT", `/api/caja/${movimientoCajaManualId}`, {
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

      const anularGasto = await request("DELETE", `/api/caja/${movimientoCajaManualId}`, {
        routeKey: "/api/caja/:id",
        token: adminToken,
        body: { motivo: "Anulación controlada por suite" },
      });
      assertHttp(anularGasto, 200, "DELETE /api/caja/:id");

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

      const reconstruir = await request("POST", "/api/caja/fondo-reconstruir", {
        routeKey: "/api/caja/fondo-reconstruir",
        token: adminToken,
      });
      assertHttp(reconstruir, 200, "POST /api/caja/fondo-reconstruir");

      const empleadoSinPermiso = await request("POST", "/api/caja/fondo-reconstruir", {
        token: employeeToken,
      });
      assertHttp(empleadoSinPermiso, 403, "POST /api/caja/fondo-reconstruir con empleado");
    });

    await t.test("Producción: crear, consultar, editar y anular lotes", async () => {
      const lista = await request("GET", "/api/produccion?page=1&limit=20", {
        routeKey: "/api/produccion",
        token: adminToken,
      });
      assertHttp(lista, 200, "GET /api/produccion");

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

    await t.test("Clientes, saldos a favor y deudas de ventas", async () => {
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

      const venta = await request("POST", "/api/ventas", {
        routeKey: "/api/ventas",
        token: adminToken,
        body: {
          fecha: FECHA_COLOMBIA,
          canal: "punto_venta",
          clientes_id: clienteId,
          credito: true,
          abono_inicial: 0,
          items: [{ productos_id: productoId, cantidad: 1, precio_unitario: 40 }],
        },
      });
      assertHttp(venta, 201, "POST /api/ventas");
      ventaId = venta.json?.data?.id;
      assert.ok(ventaId);

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

      const anularVenta = await request("DELETE", `/api/ventas/${ventaId}`, {
        routeKey: "/api/ventas/:id",
        token: adminToken,
        body: { motivo: "Anulación de venta temporal de suite" },
      });
      assertHttp(anularVenta, 200, "DELETE /api/ventas/:id");

      const eliminarCliente = await request("DELETE", `/api/clientes/${clienteId}`, {
        routeKey: "/api/clientes/:id",
        token: adminToken,
      });
      assertHttp(eliminarCliente, 200, "DELETE /api/clientes/:id");
    });

    await t.test("Caja, reportes y catálogo público: consultas finales", async () => {
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

    await t.test("Cobertura declarada de endpoints", async () => {
      const faltantes = EXPECTED_ENDPOINTS.filter((endpoint) => !cobertura.has(endpoint));
      assert.deepEqual(faltantes, [], `Quedaron endpoints sin ejecutar: ${faltantes.join(", ")}`);
      assert.equal(EXPECTED_ENDPOINTS.length, 76, "El inventario esperado contiene 75 endpoints de módulo más /health.");
    });
  } finally {
    await limpiarEntornoPruebas(entorno);
  }
});
