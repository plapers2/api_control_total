import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../../db/prisma.js";
import { noEncontrado } from "../../utils/errors.js";

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

// ── Invitar/crear un empleado en la empresa (solo admin) ─────────────
const ROLES_ASIGNABLES = ["admin", "empleado"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const crearEmpleado = async ({ nombre, email, password, empresasId, rolNombre = "empleado" }) => {
  const error = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });

  nombre = String(nombre ?? "").trim();
  email = String(email ?? "").trim().toLowerCase();
  if (!nombre) throw error("El nombre es requerido.");
  if (!EMAIL_RE.test(email)) throw error("El email no es válido.");
  // Mismo mínimo que cambiarPassword
  if (String(password ?? "").length < 8) throw error("La contraseña debe tener al menos 8 caracteres.");
  if (!ROLES_ASIGNABLES.includes(rolNombre)) throw error("Rol no válido.");

  const rol = await prisma.roles.findFirst({ where: { nombre: rolNombre } });
  if (!rol) throw error('Rol "' + rolNombre + '" no existe. Crea los roles primero.');

  const hash = await bcrypt.hash(password, 10); // fuera de la transacción: es lento

  return prisma.$transaction(async (tx) => {
    let usuario = await tx.usuarios.findUnique({ where: { email } });

    if (!usuario) {
      // La clave que escribe el admin es temporal: el empleado debe cambiarla
      // en su primer ingreso (así el admin no la conoce para siempre).
      usuario = await tx.usuarios.create({
        data: { nombre, email, password: hash, debe_cambiar_password: true },
      });
    } else if (usuario.activo === false) {
      throw error("Ese usuario está desactivado en el sistema.");
    }

    const membresia = await tx.usuarios_empresas.findFirst({
      where: { usuarios_id: usuario.id, empresas_id: empresasId },
    });
    if (membresia?.activo) throw error("Este usuario ya pertenece a la empresa.");

    if (membresia) {
      // Estaba desactivado en esta empresa: se reactiva con el rol indicado
      await tx.usuarios_empresas.update({
        where: { id: membresia.id },
        data: { activo: true, roles_id: rol.id },
      });
    } else {
      await tx.usuarios_empresas.create({
        data: { usuarios_id: usuario.id, empresas_id: empresasId, roles_id: rol.id },
      });
    }

    const { password: _, ...sinPassword } = usuario;
    return { usuario: sinPassword, rol: rolNombre, reactivado: !!membresia };
  });
};

// ── Listar miembros de la empresa ────────────────────────────────────
const listarMiembros = async (empresasId) =>
  prisma.usuarios_empresas.findMany({
    where: { empresas_id: empresasId, activo: true },
    include: { usuarios: { select: { id: true, nombre: true, email: true, activo: true } }, roles: true },
  });

// ── Desactivar miembro (sin borrar el usuario global) ────────────────

const desactivarMiembro = async (usuariosEmpresasId, empresasId, usuarioActualId) => {
  if (!Number.isInteger(usuariosEmpresasId) || usuariosEmpresasId <= 0) {
    throw noEncontrado("Miembro no encontrado.");
  }

  return prisma.$transaction(async (tx) => {
    // Serializa las desactivaciones dentro de la misma empresa.
    await tx.$queryRaw`
      SELECT id
      FROM empresas
      WHERE id = ${empresasId}
      FOR UPDATE
    `;

    const membresia = await tx.usuarios_empresas.findFirst({
      where: {
        id: usuariosEmpresasId,
        empresas_id: empresasId,
        activo: true,
      },
      include: { roles: true },
    });

    if (!membresia) {
      throw noEncontrado("Miembro no encontrado.");
    }

    if (membresia.usuarios_id === usuarioActualId) {
      throw Object.assign(new Error("No puedes desactivarte a ti mismo."), { status: 400 });
    }

    if (membresia.roles?.nombre === "admin") {
      const administradoresActivos = await tx.usuarios_empresas.count({
        where: {
          empresas_id: empresasId,
          activo: true,
          roles: { is: { nombre: "admin" } },
          usuarios: { is: { activo: true } },
        },
      });

      if (administradoresActivos <= 1) {
        throw Object.assign(new Error("No puedes desactivar al último administrador de la empresa."), { status: 400 });
      }
    }

    return tx.usuarios_empresas.update({
      where: { id: membresia.id },
      data: { activo: false },
    });
  });
};

const cambiarPassword = async (usuarioId, { passwordActual, passwordNuevo }) => {
  const error = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });

  const usuario = await prisma.usuarios.findUnique({
    where: { id: usuarioId },
    omit: { password: false },
  });

  const coincide = await bcrypt.compare(passwordActual, usuario.password);
  if (!coincide) throw error("La contraseña actual es incorrecta.");
  if (passwordNuevo.length < 8) throw error("La nueva contraseña debe tener al menos 8 caracteres.");
  if (passwordNuevo === passwordActual) throw error("La nueva contraseña debe ser distinta a la actual.");

  await prisma.usuarios.update({
    where: { id: usuarioId },
    data: {
      password: await bcrypt.hash(passwordNuevo, 10),
      debe_cambiar_password: false,
    },
  });
};

export { registrar, login, seleccionarEmpresa, obtenerPerfil, crearEmpleado, listarMiembros, desactivarMiembro, cambiarPassword };
