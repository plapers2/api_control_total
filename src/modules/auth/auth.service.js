import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../../db/prisma.js";

// ── Helper para generar el JWT ──────────────────────────────────────
const generarToken = (payload) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });

// ── Registrar un nuevo usuario ──────────────────────────────────────
const registrar = async ({ nombre, email, password }) => {
  const existe = await prisma.usuarios.findUnique({ where: { email } });
  if (existe) {
    const error = new Error("El email ya está registrado.");
    error.status = 400;
    throw error;
  }

  const hash = await bcrypt.hash(password, 10);
  const usuario = await prisma.usuarios.create({
    data: { nombre, email, password: hash },
  });

  const { password: _, ...usuarioSinPassword } = usuario;
  const token = generarToken({ id: usuario.id });

  return { token, usuario: usuarioSinPassword };
};

// ── Login ────────────────────────────────────────────────────────────
const login = async ({ email, password }) => {
  const usuario = await prisma.usuarios.findFirst({
    where: { email, activo: true },
    omit: { password: false },
  });

  // Mensaje genérico para no revelar si el email existe o no
  const credencialesInvalidas = () => {
    const error = new Error("Credenciales incorrectas.");
    error.status = 401;
    throw error;
  };

  if (!usuario) credencialesInvalidas();

  const coincide = await bcrypt.compare(password, usuario.password);
  if (!coincide) credencialesInvalidas();

  // Token sin empresa todavía; el cliente selecciona empresa después
  const token = generarToken({ id: usuario.id });

  // Empresas a las que pertenece, para mostrar el selector
  const membresias = await prisma.usuarios_empresas.findMany({
    where: { usuarios_id: usuario.id, activo: true },
    include: { empresas: true, roles: true },
  });

  const { password: _, ...usuarioSinPassword } = usuario;
  return { token, usuario: usuarioSinPassword, empresas: membresias };
};

// ── Seleccionar empresa activa ──────────────────────────────────────
const seleccionarEmpresa = async ({ usuarioId, empresasId }) => {
  const membresia = await prisma.usuarios_empresas.findFirst({
    where: { usuarios_id: usuarioId, empresas_id: empresasId, activo: true },
    include: { roles: true },
  });

  if (!membresia) {
    const error = new Error("Sin acceso a esta empresa.");
    error.status = 403;
    throw error;
  }

  const token = generarToken({ id: usuarioId, empresas_id: empresasId });
  return { token, rol: membresia.roles?.nombre };
};

// ── Datos del usuario autenticado ───────────────────────────────────
const obtenerPerfil = async (usuarioId) => {
  const membresias = await prisma.usuarios_empresas.findMany({
    where: { usuarios_id: usuarioId, activo: true },
    include: { empresas: true, roles: true },
  });

  return { empresas: membresias };
};

export { registrar, login, seleccionarEmpresa, obtenerPerfil };
