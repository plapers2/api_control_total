require("dotenv").config();
const { PrismaClient } = require("../generated/prisma");
const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
const bcrypt = require("bcryptjs");

const adapter = new PrismaMariaDb(process.env.DATABASE_URL);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Rol
  const rol = await prisma.roles.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, nombre: "admin" },
  });

  // Usuario
  const hash = await bcrypt.hash("123456", 10);
  const usuario = await prisma.usuarios.upsert({
    where: { email: "mateo@controltotal.com" },
    update: {},
    create: {
      nombre: "Mateo",
      email: "mateo@controltotal.com",
      password: hash,
    },
  });

  // Empresa
  const empresa = await prisma.empresas.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, nombre: "Mi Arepita Querida" },
  });

  // Usuario-Empresa
  await prisma.usuarios_empresas.upsert({
    where: { usuarios_id_empresas_id: { usuarios_id: usuario.id, empresas_id: empresa.id } },
    update: {},
    create: {
      usuarios_id: usuario.id,
      empresas_id: empresa.id,
      roles_id: rol.id,
    },
  });

  // Insumos
  const harina = await prisma.insumos.create({
    data: {
      empresas_id: empresa.id,
      nombre: "Harina de maiz",
      unidad_medida: "kg",
      stock_actual: 10,
      stock_minimo: 5,
      precio_unidad: 3000,
    },
  });

  const hogao = await prisma.insumos.create({
    data: {
      empresas_id: empresa.id,
      nombre: "Hogao",
      unidad_medida: "kg",
      stock_actual: 1,
      stock_minimo: 2,
      precio_unidad: 8000,
    },
  });

  const queso = await prisma.insumos.create({
    data: {
      empresas_id: empresa.id,
      nombre: "Queso costeno",
      unidad_medida: "kg",
      stock_actual: 0.5,
      stock_minimo: 1,
      precio_unidad: 15000,
    },
  });

  // Producto
  const arepa = await prisma.productos.create({
    data: {
      empresas_id: empresa.id,
      nombre: "Arepa con hogao",
      descripcion: "Arepa de maiz con hogao casero",
      precio_venta: 3000,
      stock_actual: 0,
    },
  });

  // Receta
  await prisma.recetas.createMany({
    data: [
      { productos_id: arepa.id, insumos_id: harina.id, cantidad: 0.1 },
      { productos_id: arepa.id, insumos_id: hogao.id, cantidad: 0.05 },
    ],
  });

  // Cliente
  await prisma.clientes.create({
    data: {
      empresas_id: empresa.id,
      nombre: "Juan Perez",
      telefono: "3001234567",
      direccion: "Calle 10 # 5-20",
    },
  });

  console.log("✅ Seed completado");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
