import prisma from "../../db/prisma.js";
import { primerRegistro } from "../reportes/primerRegistro.service.js";

const SERVICIOS = ["energia", "agua", "gas"];
const NOMBRES = { energia: "Energía", agua: "Agua", gas: "Gas" };

const fechaLocalColombia = () => {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const valor = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return { year: Number(valor.year), month: Number(valor.month), day: Number(valor.day) };
};

const claveMes = (year, month) => `${year}-${String(month).padStart(2, "0")}`;
const sumarMes = (year, month, delta) => {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
};
const diasMes = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const obtenerConfiguracion = async (empresasId) => {
  const filas = await prisma.configuracion_servicios_publicos.findMany({ where: { empresas_id: empresasId } });
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
      select: { tipo_servicio: true, fecha: true, periodo_servicio: true, monto: true, descripcion: true },
      orderBy: { fecha: "asc" },
    }),
  ]);

  if (!primero.fecha) {
    return { fechaInicio: null, servicios: SERVICIOS.map((servicio) => ({ servicio, nombre: NOMBRES[servicio], diaPago: configuracion[servicio] ?? null, meses: [], pendientes: 0, registrados: 0, proximoVencimiento: null })) };
  }

  const [inicioYear, inicioMonth] = primero.fecha.split("-").map(Number);
  const hoy = fechaLocalColombia();
  const totalMeses = (hoy.year - inicioYear) * 12 + hoy.month - inicioMonth + 1;
  const meses = Array.from({ length: Math.max(0, totalMeses) }, (_, i) => {
    const fecha = sumarMes(inicioYear, inicioMonth, i);
    return { clave: claveMes(fecha.year, fecha.month), ...fecha };
  });

  const registrados = new Map(SERVICIOS.map((s) => [s, new Set()]));
  for (const mov of movimientos) {
    const mes = mov.periodo_servicio || mov.fecha.toISOString().slice(0, 7);
    if (registrados.has(mov.tipo_servicio)) registrados.get(mov.tipo_servicio).add(mes);
  }

  const servicios = SERVICIOS.map((servicio) => {
    const diaPago = configuracion[servicio] ?? null;
    const mesesServicio = meses.map((mes) => {
      const registrado = registrados.get(servicio).has(mes.clave);
      const dia = diaPago ? Math.min(diaPago, diasMes(mes.year, mes.month)) : null;
      const fechaVencimiento = dia ? `${mes.clave}-${String(dia).padStart(2, "0")}` : null;
      return { mes: mes.clave, registrado, diaPago: dia, fechaVencimiento };
    });
    const pendientes = mesesServicio.filter((m) => !m.registrado).length;
    let proximoVencimiento = null;
    if (diaPago) {
      let proximoMes = { year: hoy.year, month: hoy.month };
      let diaProximo = Math.min(diaPago, diasMes(proximoMes.year, proximoMes.month));
      if (diaProximo < hoy.day) {
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
      registrados: mesesServicio.length - pendientes,
      meses: mesesServicio,
      proximoVencimiento,
    };
  });

  return { fechaInicio: primero.fecha, servicios };
};

export const guardarConfiguracion = async (empresasId, datos) => {
  const { servicio, dia_pago } = datos;
  if (!SERVICIOS.includes(servicio)) {
    const error = new Error("El servicio debe ser energia, agua o gas."); error.status = 400; throw error;
  }
  const dia = Number(dia_pago);
  if (!Number.isInteger(dia) || dia < 1 || dia > 31) {
    const error = new Error("El día de pago debe ser un número entre 1 y 31."); error.status = 400; throw error;
  }
  return prisma.configuracion_servicios_publicos.upsert({
    where: { empresas_id_servicio: { empresas_id: empresasId, servicio } },
    create: { empresas_id: empresasId, servicio, dia_pago: dia },
    update: { dia_pago: dia },
  });
};
