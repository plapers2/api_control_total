import "dotenv/config";
import bcrypt from "bcryptjs";
import prisma from "../src/db/prisma.js";
import { generarPasswordTemporal } from "../src/utils/password.js";

const email = process.argv[2]?.trim().toLowerCase();
const nombre = process.argv[3] || "Superadmin";

if (!email) {
  console.error('Uso: node scripts/crear-superadmin.js correo@dominio.com ["Nombre"]');
  process.exit(1);
}

for (const rol of ["admin", "empleado"]) {
  await prisma.roles.upsert({ where: { nombre: rol }, update: {}, create: { nombre: rol } });
}

const existente = await prisma.usuarios.findUnique({ where: { email } });

if (existente) {
  await prisma.usuarios.update({ where: { id: existente.id }, data: { es_superadmin: true } });
  console.log(`✅ ${email} ahora es superadmin (conserva su contraseña).`);
} else {
  const temporal = generarPasswordTemporal();
  await prisma.usuarios.create({
    data: {
      nombre,
      email,
      password: await bcrypt.hash(temporal, 10),
      es_superadmin: true,
      debe_cambiar_password: true,
    },
  });
  console.log(`✅ Superadmin creado: ${email}`);
  console.log(`🔑 Contraseña temporal (cámbiala al entrar): ${temporal}`);
}

await prisma.$disconnect();
