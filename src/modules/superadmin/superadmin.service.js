import bcrypt from "bcryptjs";
import prisma from "../../db/prisma.js";
import { generarPasswordTemporal } from "../../utils/password.js";
import { noEncontrado } from "../../utils/errors.js";

const badRequest = (mensaje) => Object.assign(new Error(mensaje), { status: 400 });

// admin = { usuarios_id }  → asigna un usuario existente
// admin = { nombre, email } → crea un usuario nuevo con contraseña temporal
const crearEmpresaConAdmin = async ({ nombre, descripcion, admin }) => {
  const rolAdmin = await prisma.roles.findUnique({ where: { nombre: "admin" } });
  if (!rolAdmin) throw Object.assign(new Error('No existe el rol "admin". Ejecuta el seed.'), { status: 500 });

  let passwordTemporal = null;

  const resultado = await prisma.$transaction(async (tx) => {
    let usuario;

    if (admin.usuarios_id) {
      usuario = await tx.usuarios.findFirst({ where: { id: Number(admin.usuarios_id), activo: true } });
      if (!usuario) throw noEncontrado("El usuario indicado no existe o está inactivo.");
    } else {
      const email = admin.email.trim().toLowerCase();
      const existe = await tx.usuarios.findUnique({ where: { email } });
      if (existe) {
        throw badRequest("Ese email ya existe. Usa usuarios_id para asignarlo como admin.");
      }

      passwordTemporal = generarPasswordTemporal();
      usuario = await tx.usuarios.create({
        data: {
          nombre: admin.nombre.trim(),
          email,
          password: await bcrypt.hash(passwordTemporal, 10),
          debe_cambiar_password: true,
        },
      });
    }

    const empresa = await tx.empresas.create({ data: { nombre, descripcion } });

    await tx.usuarios_empresas.create({
      data: { usuarios_id: usuario.id, empresas_id: empresa.id, roles_id: rolAdmin.id },
    });

    return { empresa, usuario };
  });

  return {
    empresa: resultado.empresa,
    admin: { id: resultado.usuario.id, nombre: resultado.usuario.nombre, email: resultado.usuario.email },
    // Solo viene si se creó un usuario nuevo. Se muestra una única vez.
    password_temporal: passwordTemporal,
  };
};

const listarEmpresas = async () =>
  prisma.empresas.findMany({
    orderBy: { id: "asc" },
    include: {
      usuarios_empresas: {
        where: { activo: true, roles: { nombre: "admin" } },
        include: { usuarios: { select: { id: true, nombre: true, email: true } } },
      },
    },
  });

export { crearEmpresaConAdmin, listarEmpresas };
