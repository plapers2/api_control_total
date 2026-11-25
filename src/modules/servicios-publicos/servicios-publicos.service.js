import prisma from "../../db/prisma.js";
import { primerRegistro } from "../reportes/primerRegistro.service.js";

const SERVICIOS = ["energia", "agua", "gas"];
const NOMBRES = { energia: "Energía", agua: "Agua", gas: "Gas" };

const crearError = (mensaje, status = 400) => Object.assign(new Error(mensaje), { status });

const fechaLocalColombia = () => {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const valor = Object.fromEntries(partes.map((p) => [p.type, p.value]));

  return {
    year: Number(valor.year),
    month: Number(valor.month),
    day: Number(valor.day),
  };
};

const claveMes = (year, month) => `${year}-${String(month).padStart(2, "0")}`;

const sumarMes = (year, month, delta) => {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));

  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
  };
};

const diasMes = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const obtenerConfiguracion = async (empresasId) => {
  const filas = await prisma.configuracion_servicios_publicos.findMany({
    where: { empresas_id: empresasId },
  });

  return Object.fromEntries(filas.map((f) => [f.servicio, f.dia_pago]));
};

export const resumen = async (empresasId) => {
  const [primero, configuracion, movimientos] = await Promise.all([
    primerRegistro(empresasId),
    obtenerConfiguracion(empresasId),
    prisma.movimientos_caja.findMany({
      where: {
        empresas_id: empresasId,
        anulado: false,
        tipo: "gasto",
        categoria: "servicio_publico",
        tipo_servicio: { in: SERVICIOS },
      },
      select: {
        tipo_servicio: true,
        fecha: true,
        periodo_servicio: true,
        monto: true,
        descripcion: true,
      },
      orderBy: { fecha: "asc" },
    }),
  ]);

  if (!primero.fecha) {
    return {
      fechaInicio: null,
      servicios: SERVICIOS.map((servicio) => ({
        servicio,
        nombre: NOMBRES[servicio],
        diaPago: configuracion[servicio] ?? null,
        meses: [],
        pendientes: 0,
        registrados: 0,
        proximoVencimiento: null,
        vencidos: 0,
        mesesVencidos: [],
      })),
    };
  }

  const [inicioYear, inicioMonth] = primero.fecha.split("-").map(Number);
  const hoy = fechaLocalColombia();

  const totalMeses = (hoy.year - inicioYear) * 12 + hoy.month - inicioMonth + 1;

  const meses = Array.from({ length: Math.max(0, totalMeses) }, (_, i) => {
    const fecha = sumarMes(inicioYear, inicioMonth, i);

    return {
      clave: claveMes(fecha.year, fecha.month),
      ...fecha,
    };
  });

  const registrados = new Map(SERVICIOS.map((s) => [s, new Set()]));

  for (const mov of movimientos) {
    const mes = mov.periodo_servicio || mov.fecha.toISOString().slice(0, 7);

    if (registrados.has(mov.tipo_servicio)) {
      registrados.get(mov.tipo_servicio).add(mes);
    }
  }

  const servicios = SERVICIOS.map((servicio) => {
    const diaPago = configuracion[servicio] ?? null;

    const mesesServicio = meses.map((mes) => {
      const registrado = registrados.get(servicio).has(mes.clave);

      const dia = diaPago ? Math.min(diaPago, diasMes(mes.year, mes.month)) : null;

      const fechaVencimiento = dia ? `${mes.clave}-${String(dia).padStart(2, "0")}` : null;

      return {
        mes: mes.clave,
        registrado,
        diaPago: dia,
        fechaVencimiento,
      };
    });

    const pendientes = mesesServicio.filter((m) => !m.registrado).length;

    const fechaHoy = `${claveMes(hoy.year, hoy.month)}-${String(hoy.day).padStart(2, "0")}`;

    const mesesVencidos = mesesServicio
      .filter((m) => !m.registrado && m.fechaVencimiento && m.fechaVencimiento < fechaHoy)
      .map((m) => m.mes);

    const vencidos = mesesVencidos.length;

    let proximoVencimiento = null;

    if (diaPago) {
      let proximoMes = { year: hoy.year, month: hoy.month };

      let diaProximo = Math.min(diaPago, diasMes(proximoMes.year, proximoMes.month));

      const periodoActual = claveMes(hoy.year, hoy.month);
      const reciboActualRegistrado = registrados.get(servicio).has(periodoActual);

      if (diaProximo < hoy.day || reciboActualRegistrado) {
        proximoMes = sumarMes(hoy.year, hoy.month, 1);

        diaProximo = Math.min(diaPago, diasMes(proximoMes.year, proximoMes.month));
      }

      proximoVencimiento = `${claveMes(proximoMes.year, proximoMes.month)}-${String(diaProximo).padStart(2, "0")}`;
    }

    return {
      servicio,
      nombre: NOMBRES[servicio],
      diaPago,
      pendientes,
      vencidos,
      mesesVencidos,
      registrados: mesesServicio.length - pendientes,
      meses: mesesServicio,
      proximoVencimiento,
    };
  });

  return { fechaInicio: primero.fecha, servicios };
};

// Comprueba que el servicio y el periodo pertenecen al rango de control.
export const validarPeriodoControlado = async (empresasId, servicio, periodo) => {
  if (!SERVICIOS.includes(servicio)) {
    throw crearError("Selecciona un servicio público válido.");
  }

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodo ?? ""))) {
    throw crearError("Selecciona un mes válido para el recibo.");
  }

  const datos = await resumen(empresasId);

  const servicioDatos = datos.servicios.find((s) => s.servicio === servicio);

  const mes = servicioDatos?.meses.find((m) => m.mes === periodo);

  if (!mes) {
    throw crearError("El mes seleccionado no está dentro del periodo de control.");
  }
};

// Serializa los registros y ediciones de servicios públicos por empresa.
export const bloquearEmpresaServiciosPublicos = async (tx, empresasId) => {
  const empresa = await tx.$queryRaw`
    SELECT id
    FROM empresas
    WHERE id = ${empresasId}
    FOR UPDATE
  `;

  if (!empresa.length) {
    throw crearError("No se encontró la empresa.", 404);
  }
};

// Comprueba duplicados dentro de la transacción.
// También reconoce recibos antiguos cuyo periodo se deduce de la fecha.
export const validarReciboUnico = async (tx, { empresasId, servicio, periodo, excluirMovimientoId = null }) => {
  const [year, month] = periodo.split("-").map(Number);

  const desde = new Date(Date.UTC(year, month - 1, 1));
  const hasta = new Date(Date.UTC(year, month, 1));

  // Los IDs válidos son positivos; 0 significa que no se excluye ninguno.
  const idExcluir = Number.isInteger(excluirMovimientoId) && excluirMovimientoId > 0 ? excluirMovimientoId : 0;

  const existentes = await tx.$queryRaw`
    SELECT id
    FROM movimientos_caja
    WHERE empresas_id = ${empresasId}
      AND anulado = 0
      AND tipo = 'gasto'
      AND categoria = 'servicio_publico'
      AND tipo_servicio = ${servicio}
      AND id <> ${idExcluir}
      AND (
        periodo_servicio = ${periodo}
        OR (
          periodo_servicio IS NULL
          AND fecha >= ${desde}
          AND fecha < ${hasta}
        )
      )
    LIMIT 1
    FOR UPDATE
  `;

  if (existentes.length > 0) {
    throw crearError("Ese recibo ya aparece registrado para el servicio y periodo seleccionados.", 409);
  }
};

export const guardarConfiguracion = async (empresasId, datos) => {
  const { servicio, dia_pago } = datos;

  if (!SERVICIOS.includes(servicio)) {
    throw crearError("El servicio debe ser energia, agua o gas.");
  }

  const dia = Number(dia_pago);

  if (!Number.isInteger(dia) || dia < 1 || dia > 31) {
    throw crearError("El día de pago debe ser un número entre 1 y 31.");
  }

  return prisma.configuracion_servicios_publicos.upsert({
    where: {
      empresas_id_servicio: {
        empresas_id: empresasId,
        servicio,
      },
    },
    create: {
      empresas_id: empresasId,
      servicio,
      dia_pago: dia,
    },
    update: {
      dia_pago: dia,
    },
  });
};
