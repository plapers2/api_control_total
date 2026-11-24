import prisma from "../../db/prisma.js";
import { fechaColombiaToUTC } from "../../utils/timezone.js";
import { noEncontrado } from "../../utils/errors.js";

const badRequest = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });
const SUMAN = ["deposito", "reintegro"];

// Aplica un movimiento al saldo a favor DENTRO de una transacción.
// deposito y reintegro suman; uso y devolucion restan. Si el saldo quedara
// negativo lanza un 400 y la transacción completa se revierte.
const moverSaldo = async (tx, { empresasId, clientesId, usuariosId, ventasId = null, tipo, monto, nota, fecha }) => {
  const cliente = await tx.clientes.findFirst({ where: { id: clientesId, empresas_id: empresasId } });
  if (!cliente) throw noEncontrado("Cliente no encontrado.");

  const suma = SUMAN.includes(tipo);
  await tx.clientes.update({
    where: { id: clientesId },
    data: { saldo_favor: suma ? { increment: monto } : { decrement: monto } },
  });
  if (!suma) {
    const negativo = await tx.clientes.findFirst({ where: { id: clientesId, saldo_favor: { lt: 0 } } });
    if (negativo) throw badRequest("El saldo a favor del cliente no alcanza.");
  }

  await tx.saldos_cliente.create({
    data: { empresas_id: empresasId, clientes_id: clientesId, usuarios_id: usuariosId, ventas_id: ventasId, tipo, monto, nota, fecha },
  });
  return cliente;
};

// Dejar saldo (deposito) o devolver dinero al cliente (devolucion).
// Si registrarEnCaja, el movimiento también queda en Caja (ingreso o gasto).
const registrarSaldo = async (clientesId, empresasId, usuariosId, { tipo, monto, nota, fecha, registrarEnCaja = true }) => {
  if (!["deposito", "devolucion"].includes(tipo)) throw badRequest("Tipo de movimiento inválido.");
  if (!Number.isFinite(monto) || monto <= 0) throw badRequest("El monto debe ser mayor a 0.");

  return prisma.$transaction(async (tx) => {
    const fechaUTC = fechaColombiaToUTC(fecha);
    const cliente = await moverSaldo(tx, { empresasId, clientesId, usuariosId, tipo, monto, nota, fecha: fechaUTC });

    if (registrarEnCaja) {
      await tx.movimientos_caja.create({
        data: {
          empresas_id: empresasId,
          usuarios_id: usuariosId,
          clientes_id: clientesId,
          tipo: tipo === "deposito" ? "ingreso" : "gasto",
          categoria: "otro",
          monto,
          descripcion: tipo === "deposito" ? `Saldo a favor de ${cliente.nombre}` : `Devolución de saldo a ${cliente.nombre}`,
          fecha: fechaUTC,
        },
      });
    }

    const actual = await tx.clientes.findFirst({ where: { id: clientesId } });
    return { saldo_favor: Number(actual.saldo_favor) };
  });
};

const obtenerSaldo = async (clientesId, empresasId) => {
  const cliente = await prisma.clientes.findFirst({ where: { id: clientesId, empresas_id: empresasId } });
  if (!cliente) throw noEncontrado("Cliente no encontrado.");

  const movimientos = await prisma.saldos_cliente.findMany({
    where: { clientes_id: clientesId, empresas_id: empresasId },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: 50,
  });

  return {
    saldo_favor: Number(cliente.saldo_favor),
    movimientos: movimientos.map((m) => ({
      id: m.id,
      tipo: m.tipo,
      monto: Number(m.monto),
      nota: m.nota,
      fecha: m.fecha,
      ventas_id: m.ventas_id,
    })),
  };
};

export { moverSaldo, registrarSaldo, obtenerSaldo };
