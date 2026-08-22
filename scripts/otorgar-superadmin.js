"use strict";
/*
 * Otorga el rol de superAdmin (dueño de la plataforma, puede ver/eliminar
 * CUALQUIER empresa) a un correo. A propósito NO existe como ruta HTTP --
 * el rol vive en una tabla separada (platform_admins) que ningún endpoint
 * que el cliente pueda llamar alcanza ni escribe. Solo se otorga corriendo
 * este script a mano, con acceso directo al servidor/base de datos.
 *
 * Uso (con DATABASE_URL ya definida en el entorno, ej. en el Shell de
 * Render del servicio del backend, o exportándola vos mismo):
 *   node scripts/otorgar-superadmin.js correo@ejemplo.com
 */
const { Pool } = require("pg");

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Uso: node scripts/otorgar-superadmin.js correo@ejemplo.com");
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
    await pool.query(
      "CREATE TABLE IF NOT EXISTS platform_admins (email TEXT PRIMARY KEY)"
    );
    await pool.query(
      "INSERT INTO platform_admins (email) VALUES ($1) ON CONFLICT DO NOTHING",
      [email]
    );
    console.log(`Listo: "${email}" ahora es superAdmin de la plataforma.`);
  } catch (err) {
    console.error("No se pudo otorgar superAdmin:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
