"use strict";
// Resguardos del sembrado de datos de prueba (staging): nunca en producción
// ni sobre una base que tenga datos reales.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const A = require("./ayudantes");
const S = require("../scripts/datos-prueba");

const hash = (c) => { const s = crypto.randomBytes(16).toString("hex"); return `scrypt:${s}:${crypto.scryptSync(c, s, 64).toString("hex")}`; };
let pool, srv;
const env = { ...process.env };
test.before(async () => { pool = await A.prepararBase(); srv = await A.arrancarServidor(); }); // crea el esquema
test.after(async () => { process.env = env; await srv.detener(); await pool.end(); });

test("se niega en el servicio de producción", async () => {
  process.env.RENDER_SERVICE_NAME = S.NOMBRE_SERVICIO_PRODUCCION; process.env.CLAVE_DATOS_PRUEBA = "una-clave-larga";
  await assert.rejects(S.sembrarSiCorresponde(pool, { hashPassword: hash }), /producción/);
  delete process.env.RENDER_SERVICE_NAME;
});
test("exige CLAVE_DATOS_PRUEBA", async () => {
  process.env.CLAVE_DATOS_PRUEBA = "corta";
  await assert.rejects(S.sembrarSiCorresponde(pool, { hashPassword: hash }), /CLAVE_DATOS_PRUEBA/);
});
test("se niega si hay datos que no son de prueba, sin escribir nada", async () => {
  process.env.CLAVE_DATOS_PRUEBA = "una-clave-larga";
  await pool.query("INSERT INTO records (company_id, store, id, data) VALUES ('pehuen','areas','real-1','{\"id\":\"real-1\",\"nombre\":\"Real\"}')");
  await assert.rejects(S.sembrarSiCorresponde(pool, { hashPassword: hash }), /no son de prueba/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM records WHERE company_id LIKE 'prueba-%'")).rows[0].n, 0);
  await pool.query("DELETE FROM records WHERE id='real-1'");
});
test("en una base vacía siembra una vez y no repite", async () => {
  assert.equal(await S.sembrarSiCorresponde(pool, { hashPassword: hash }), true);
  const n = (await pool.query("SELECT count(*)::int n FROM records")).rows[0].n;
  assert.ok(n > 50);
  assert.equal(await S.sembrarSiCorresponde(pool, { hashPassword: hash }), false);
  assert.equal((await pool.query("SELECT count(*)::int n FROM records")).rows[0].n, n);
  const correos = (await pool.query("SELECT data->>'email' e FROM records WHERE store='accesoUsuarios'")).rows.map((r) => r.e);
  assert.ok(correos.every((e) => e.endsWith(".example")), "solo correos del dominio reservado .example");
});
