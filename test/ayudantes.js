"use strict";
// Utilidades de prueba: base de datos LOCAL desechable, servidor real en un
// proceso hijo y un cliente OAuth + MCP mínimo (como claude.ai).

const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");

const DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://pehuen_test:pehuen_test@localhost/pehuen_test";
const CLAVE = "clave-de-prueba-123";
const REDIRECT = "http://localhost:8765/callback";

// Resguardo: las pruebas BORRAN la base de datos que usan. Solo se permite
// una base local cuyo nombre contenga "test".
function verificarBaseLocal() {
  const u = new URL(DATABASE_URL);
  if (!["localhost", "127.0.0.1", "::1"].includes(u.hostname) || !/test/.test(u.pathname) || /render\.com/.test(DATABASE_URL)) {
    throw new Error(`Las pruebas solo corren contra una base local de pruebas (recibido: ${u.hostname}${u.pathname}).`);
  }
}

async function prepararBase() {
  verificarBaseLocal();
  const pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  return pool;
}

let puertoSiguiente = 4100 + Math.floor(Math.random() * 500);
async function arrancarServidor(envExtra = {}) {
  verificarBaseLocal();
  const port = puertoSiguiente++;
  const hijo = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: Object.assign({}, process.env, { DATABASE_URL, JWT_SECRET: "secreto-de-pruebas", PORT: String(port), MCP_REDIRECT_URIS: `https://claude.ai/api/mcp/auth_callback,${REDIRECT}`, RENDER_EXTERNAL_URL: "" }, envExtra),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  hijo.stdout.on("data", (d) => { log += d; });
  hijo.stderr.on("data", (d) => { log += d; });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + "/health"); if (r.ok) break; } catch (e) { /* aún no */ }
    await new Promise((r) => setTimeout(r, 100));
    if (hijo.exitCode !== null) throw new Error("El servidor terminó al arrancar:\n" + log);
  }
  return { base, log: () => log, detener: () => new Promise((r) => { hijo.once("exit", r); hijo.kill(); }) };
}

// ---------- cliente OAuth (flujo completo, como claude.ai) ----------
async function registrarCliente(base, extra = {}) {
  const r = await fetch(base + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ client_name: "Cliente de prueba", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }, extra)) });
  return { status: r.status, body: await r.json() };
}
function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}
function paramsAuth(base, clientId, challenge, extra = {}) {
  return Object.assign({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "estado-xyz", scope: "lectura escritura", resource: base + "/mcp" }, extra);
}
async function postForm(url, datos) {
  return fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(datos).toString() });
}
// Hace login en la página de autorización. Devuelve {location, html, status}.
async function autorizar(base, params, { email, clave = CLAVE, escritura = true, empresaId } = {}) {
  let r = await postForm(base + "/oauth/authorize", Object.assign({}, params, { paso: "login", email, clave, accion: "permitir" }, escritura ? { permitir_escritura: "si" } : {}));
  if (r.status === 200 && empresaId) {
    const html = await r.text();
    const ticket = (/name="ticket" value="([^"]+)"/.exec(html) || [])[1];
    if (!ticket) return { status: 200, html };
    r = await postForm(base + "/oauth/authorize", Object.assign({}, params, { paso: "empresa", ticket, empresaId, accion: "permitir" }, escritura ? { permitir_escritura: "si" } : {}));
  }
  return { status: r.status, location: r.headers.get("location"), html: r.status === 302 ? "" : await r.text() };
}
async function canjear(base, datos) {
  const r = await fetch(base + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(datos).toString() });
  return { status: r.status, body: await r.json() };
}
// Flujo completo: devuelve { token, refresh, clientId, scope }.
async function conectar(base, email, opciones = {}) {
  const { body: cli } = await registrarCliente(base);
  const { verifier, challenge } = pkce();
  const params = paramsAuth(base, cli.client_id, challenge, opciones.scope ? { scope: opciones.scope } : {});
  const a = await autorizar(base, params, Object.assign({ email }, opciones));
  if (a.status !== 302) throw new Error(`autorización falló (${a.status}): ${a.html.slice(0, 300)}`);
  const code = new URL(a.location).searchParams.get("code");
  const t = await canjear(base, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: cli.client_id, code_verifier: verifier, resource: base + "/mcp" });
  if (t.status !== 200) throw new Error("canje falló: " + JSON.stringify(t.body));
  return { token: t.body.access_token, refresh: t.body.refresh_token, clientId: cli.client_id, scope: t.body.scope };
}

// ---------- cliente MCP ----------
let idRpc = 1;
async function rpc(base, token, method, params, headers = {}) {
  const r = await fetch(base + "/mcp", { method: "POST", headers: Object.assign({ "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + token }, headers), body: JSON.stringify({ jsonrpc: "2.0", id: idRpc++, method, params }) });
  const texto = await r.text();
  return { status: r.status, body: texto ? JSON.parse(texto) : null, headers: r.headers };
}
// Llama una herramienta. Devuelve { error: bool, texto, datos }.
async function herramienta(base, token, name, args = {}) {
  const r = await rpc(base, token, "tools/call", { name, arguments: args });
  if (r.body.error) return { rpcError: r.body.error };
  const res = r.body.result, texto = res.content[0].text;
  let datos = null;
  try { datos = JSON.parse(texto); } catch (e) { /* mensaje de error en texto */ }
  return { error: !!res.isError, texto, datos };
}

const correo = (rol, emp = "andes") => (rol === "multi" ? "multi@pehuen-prueba.example" : `${rol}@${emp}.pehuen-prueba.example`);

module.exports = { DATABASE_URL, CLAVE, REDIRECT, prepararBase, arrancarServidor, registrarCliente, pkce, paramsAuth, autorizar, canjear, conectar, rpc, herramienta, correo, postForm };
