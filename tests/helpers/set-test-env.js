/**
 * Este módulo se carga exclusivamente desde el script `npm test`.
 * La API hija y las pruebas deben ejecutarse en modo test aunque el .env
 * local contenga NODE_ENV=production. La protección de DB_NAME y SELECT
 * DATABASE() permanece activa en runtime.js.
 */
process.env.NODE_ENV = "test";
