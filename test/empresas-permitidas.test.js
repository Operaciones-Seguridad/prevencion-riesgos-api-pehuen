"use strict";
// Lista de empresas habilitadas para el conector (MCP_EMPRESAS_PERMITIDAS):
// cerrada por defecto, por id o por nombre, y revisada en cada llamada.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const A = require("./ayudantes");
const { construirEmpresas, insertar, hoyChile } = require("../scripts/datos-prueba");

const hash = (c) => { const s = crypto.randomBytes(16).toString("hex"); return `scrypt:${s}:${crypto.scryptSync(c, s, 64).toString("hex")}`; };
let pool;
test.before(async () => {
  pool = await A.prepararBase();
  const srv = await A.arrancarServidor(); // crea el esquema
  await insertar(pool, construirEmpresas(hoyChile(), hash(A.CLAVE)));
  await srv.detener();
});
test.after(async () => { await pool.end(); });

async function intentarLogin(base, email) {
  const { body: cli } = await A.registrarCliente(base);
  return A.autorizar(base, A.paramsAuth(base, cli.client_id, A.pkce().challenge), { email });
}

test("sin la variable, ninguna empresa puede conectarse (cerrado por defecto)", async () => {
  const srv = await A.arrancarServidor({ MCP_EMPRESAS_PERMITIDAS: "" });
  try {
    const r = await intentarLogin(srv.base, A.correo("admin"));
    assert.equal(r.status, 401);
    assert.match(r.html, /no tiene habilitada la conexión con Claude/);
  } finally { await srv.detener(); }
});

test("con la lista, solo entran las empresas incluidas (por id o por nombre sin tildes)", async () => {
  const srv = await A.arrancarServidor({ MCP_EMPRESAS_PERMITIDAS: " prueba-andes , servicios electricos imaginarios ltda. (prueba) " });
  try {
    assert.equal((await intentarLogin(srv.base, A.correo("admin"))).status, 302, "andes por id");
    assert.equal((await intentarLogin(srv.base, A.correo("admin", "sur"))).status, 302, "sur por nombre, sin tildes");
  } finally { await srv.detener(); }
  const srv2 = await A.arrancarServidor({ MCP_EMPRESAS_PERMITIDAS: "prueba-andes" });
  try {
    const r = await intentarLogin(srv2.base, A.correo("admin", "sur"));
    assert.equal(r.status, 401);
    assert.match(r.html, /no tiene habilitada/);
    // el correo que existe en ambas empresas solo ve la habilitada: no pide elegir
    const m = await intentarLogin(srv2.base, A.correo("multi"));
    assert.equal(m.status, 302);
  } finally { await srv2.detener(); }
});

test("quitar una empresa de la lista corta de inmediato los tokens ya emitidos", async () => {
  const srv = await A.arrancarServidor({ MCP_EMPRESAS_PERMITIDAS: "prueba-andes" });
  let token;
  try {
    token = (await A.conectar(srv.base, A.correo("admin"))).token;
    assert.equal((await A.rpc(srv.base, token, "ping", {})).status, 200);
  } finally { await srv.detener(); }
  const srv2 = await A.arrancarServidor({ MCP_EMPRESAS_PERMITIDAS: "prueba-sur" });
  try {
    assert.equal((await A.rpc(srv2.base, token, "ping", {})).status, 401);
  } finally { await srv2.detener(); }
});
