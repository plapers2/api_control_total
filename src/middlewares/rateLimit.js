import { rateLimit } from "express-rate-limit";

// Freno a la fuerza bruta en el login: solo cuentan los intentos fallidos
// (skipSuccessfulRequests), así que un empleado que entra bien no se bloquea.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiados intentos fallidos. Intenta de nuevo en 15 minutos." },
});

export { loginLimiter };
