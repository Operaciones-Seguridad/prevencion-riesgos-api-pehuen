"use strict";
// URL directa por empresa: /mcp/<alias> queda ligada a una sola empresa, sin
// revelar qué empresas existen a quien no tiene sesión.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const A = require("./ayudantes");
const { construirEmpresas, insertar, hoyChile } = require("../scripts/datos-prueba");
const { slugEmpresa } = require("../mcp/contexto");

const hash = (c) => { const s = crypto.randomBytes(16).toString("hex"); return `scrypt:${s}:${crypto.scryptSync(c, s, 64).toString("hex")}`; };
let pool, srv, base;
const SUR = "servicios-electricos-imaginarios-ltda-prueba";

test.before(async () => {
  pool = await A.prepararBase();
  srv = await A.arrancarServidor(); base = srv.base;
  await insertar(pool, construirEmpresas(hoyChile(), hash(A.CLAVE)));
});
test.after(async () => { await srv.detener(); await pool.end(); });

// Flujo OAuth completo contra una URL de recurso concreta.
async function conectarA(recurso, email, extra = {}) {
  const { body: cli } = await A.registrarCliente(base);
  const { verifier, challenge } = A.pkce();
  const p = A.paramsAuth(base, cli.client_id, challenge, { resource: recurso });
  const a = await A.autorizar(base, p, Object.assign({ email }, extra));
  if (a.status !== 302) return { error: a };
  const code = new URL(a.location).searchParams.get("code");
  const t = await A.canjear(base, { grant_type: "authorization_code", code, redirect_uri: A.REDIRECT, client_id: cli.client_id, code_verifier: verifier, resource: recurso });
  return { token: t.body.access_token };
}
const rpcEn = async (ruta, token, method, params) => {
  const r = await fetch(base + ruta, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: r.status, body: r.status === 200 ? await r.json() : null, headers: r.headers };
};

test("alias: nombre sin tildes, en minúsculas y con guiones", () => {
  assert.equal(slugEmpresa("Transportes Pola Ltda"), "transportes-pola-ltda");
  assert.equal(slugEmpresa("Inversiones Felipe Flores SpA"), "inversiones-felipe-flores-spa");
  assert.equal(slugEmpresa("Pehuén"), "pehuen");
  assert.equal(slugEmpresa("Servicios Eléctricos Imaginarios Ltda. (PRUEBA)"), SUR);
});

test("descubrimiento por URL y 401 que apunta a los metadatos de esa URL", async () => {
  const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp/${SUR}`)).json();
  assert.equal(pr.resource, `${base}/mcp/${SUR}`);
  const r = await rpcEn(`/mcp/${SUR}`, "x", "ping", {});
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), new RegExp(`oauth-protected-resource/mcp/${SUR}"`));
  // un alias que no existe responde igual (no revela qué empresas hay)
  const no = await rpcEn("/mcp/empresa-que-no-existe", "x", "ping", {});
  assert.equal(no.status, 401);
  assert.equal((await fetch(`${base}/mcp/con%20espacios`, { method: "POST" })).status, 404, "formato inválido");
});

test("la URL de una empresa entra directo a ella, sin pedir elegir", async () => {
  const c = await conectarA(`${base}/mcp/${SUR}`, A.correo("multi"));
  assert.ok(c.token, JSON.stringify(c.error && c.error.html && c.error.html.slice(0, 200)));
  const info = await rpcEn(`/mcp/${SUR}`, c.token, "tools/call", { name: "conexion_actual", arguments: {} });
  const datos = JSON.parse(info.body.result.content[0].text);
  assert.equal(datos.empresa.id, "prueba-sur");
  assert.equal(datos.urlDeEsteConector, `${base}/mcp/${SUR}`);
  const ini = await rpcEn(`/mcp/${SUR}`, c.token, "initialize", { protocolVersion: "2025-06-18" });
  assert.match(ini.body.result.instructions, /Servicios Eléctricos Imaginarios/);
  // el mismo correo por la URL general sí pide elegir
  const { body: cli } = await A.registrarCliente(base);
  const g = await A.autorizar(base, A.paramsAuth(base, cli.client_id, A.pkce().challenge), { email: A.correo("multi") });
  assert.match(g.html, /Elige la empresa/);
  // también por id de empresa
  assert.ok((await conectarA(`${base}/mcp/prueba-andes`, A.correo("multi"))).token);
});

test("el token queda amarrado a su URL", async () => {
  const c = await conectarA(`${base}/mcp/${SUR}`, A.correo("multi"));
  assert.equal((await rpcEn("/mcp", c.token, "ping", {})).status, 401, "no sirve en la URL general");
  assert.equal((await rpcEn("/mcp/prueba-andes", c.token, "ping", {})).status, 401, "ni en la de otra empresa");
  const g = await A.conectar(base, A.correo("admin"));
  assert.equal((await rpcEn("/mcp/prueba-andes", g.token, "ping", {})).status, 401, "un token de la URL general no sirve en una URL de empresa");
  assert.equal((await rpcEn("/mcp", g.token, "ping", {})).status, 200);
});

test("sin acceso a la empresa de la URL: mensaje genérico tras la clave", async () => {
  const a = await conectarA(`${base}/mcp/${SUR}`, A.correo("admin")); // admin de andes, no de sur
  assert.equal(a.error.status, 401);
  assert.match(a.error.html, /no tiene acceso a la empresa de este conector/);
  const b = await conectarA(`${base}/mcp/empresa-que-no-existe`, A.correo("admin"));
  assert.match(b.error.html, /no tiene acceso a la empresa de este conector/, "mismo mensaje si el alias no existe");
  const mala = await conectarA(`${base}/mcp/${SUR}`, A.correo("multi"), { clave: "mala" });
  assert.match(mala.error.html, /Correo o clave incorrectos/, "sin clave válida no se revela nada de la empresa");
  // empresa existente pero no habilitada para el conector
  const srv2 = await A.arrancarServidor({ MCP_EMPRESAS_PERMITIDAS: "prueba-andes" });
  try {
    const { body: cli } = await A.registrarCliente(srv2.base);
    const r = await A.autorizar(srv2.base, A.paramsAuth(srv2.base, cli.client_id, A.pkce().challenge, { resource: `${srv2.base}/mcp/${SUR}` }), { email: A.correo("multi") });
    assert.match(r.html, /no tiene habilitada la conexión/);
  } finally { await srv2.detener(); }
});
