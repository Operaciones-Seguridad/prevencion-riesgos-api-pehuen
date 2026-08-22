"use strict";
/*
 * Quita el rol de superAdmin a un correo (contraparte de
 * otorgar-superadmin.js). Tampoco existe como ruta HTTP.
 *
 * Uso:
 *   node scripts/revocar-superadmin.js correo@ejemplo.com
 */
const { Pool } = require("pg");

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) {
  console.error("Uso: node scripts/revocar-superadmin.js correo@ejemplo.com");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("Falta la variable de entorno DATABASE_URL. Definila antes de correr este script (ej. en el Shell de Render del backend).");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : (process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false),
});

(async () => {
  try {
    const { rowCount } = await pool.query("DELETE FROM platform_admins WHERE email = $1", [email]);
    console.log(rowCount ? `Listo: "${email}" ya no es superAdmin.` : `"${email}" no era superAdmin (no se cambió nada).`);
  } catch (err) {
    console.error("No se pudo revocar superAdmin:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
