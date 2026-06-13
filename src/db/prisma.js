const { PrismaClient } = require("../../generated/prisma");
const { PrismaMariaDb } = require("@prisma/adapter-mariadb");

const adapter = new PrismaMariaDb(process.env.DATABASE_URL);

// ── Cliente único de Prisma ─────────────────────────────────────────
// `omit` excluye campos sensibles de TODAS las queries por defecto.
// Es el equivalente al defaultScope de Sequelize, pero centralizado aquí.
const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  omit: {
    usuarios: {
      password: true,
    },
  },
});

module.exports = prisma;
