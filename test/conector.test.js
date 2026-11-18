"use strict";
// Pruebas de integración del conector MCP contra el servidor real y una
// base PostgreSQL LOCAL desechable (ver test/ayudantes.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const A = require("./ayudantes");
const { construirEmpresas, insertar, hoyChile } = require("../scripts/datos-prueba");

function hashClave(c) { const salt = crypto.randomBytes(16).toString("hex"); return `scrypt:${salt}:${crypto.scryptSync(c, salt, 64).toString("hex")}`; }

let pool, srv, base;
const tokens = {};
async function auditoria(where = "true", vals = []) { return (await pool.query(`SELECT * FROM auditoria_escrituras WHERE ${where} ORDER BY id`, vals)).rows; }
async function registro(company, store, id) { const { rows } = await pool.query("SELECT data, updated_at FROM records WHERE company_id=$1 AND store=$2 AND id=$3", [company, store, id]); return rows[0] ? rows[0].data : null; }
async function conteos() { const { rows } = await pool.query("SELECT company_id, store, count(*)::int n FROM records GROUP BY 1,2"); return Object.fromEntries(rows.map((r) => [r.company_id + "/" + r.store, r.n])); }
const H = (rol, name, args) => A.herramienta(base, tokens[rol], name, args);

test.before(async () => {
  pool = await A.prepararBase();
  srv = await A.arrancarServidor();
  base = srv.base;
  await insertar(pool, construirEmpresas(hoyChile(), hashClave(A.CLAVE)));
  // empresa pendiente de aprobación, para probar el rechazo
  await pool.query("INSERT INTO empresas (id, nombre, aprobada) VALUES ('prueba-pendiente','Pendiente SpA', false)");
  await pool.query("INSERT INTO records (company_id, store, id, data) VALUES ('prueba-pendiente','accesoUsuarios','u1',$1)", [{ id: "u1", nombre: "P", email: "pendiente@pehuen-prueba.example", claveHash: hashClave(A.CLAVE), activo: true, perfilId: "x" }]);
  for (const rol of ["admin", "prevencionista", "supervisor", "trabajador", "capacitacion"]) tokens[rol] = (await A.conectar(base, A.correo(rol))).token;
  tokens.lectura = (await A.conectar(base, A.correo("prevencionista"), { escritura: false })).token;
  tokens.sur = (await A.conectar(base, A.correo("admin", "sur"))).token;
});
test.after(async () => { if (srv) await srv.detener(); if (pool) await pool.end(); });

// ======================= OAuth =======================
test("OAuth: descubrimiento RFC 9728 / RFC 8414 y 401 con WWW-Authenticate", async () => {
  const pr = await (await fetch(base + "/.well-known/oauth-protected-resource")).json();
  assert.equal(pr.resource, base + "/mcp");
  assert.deepEqual(pr.authorization_servers, [base]);
  const as = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.registration_endpoint, base + "/oauth/register");
  const r = await A.rpc(base, "token-falso", "initialize", {});
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);
});

test("OAuth: registro dinámico solo acepta las URL de retorno permitidas", async () => {
  assert.equal((await A.registrarCliente(base, { redirect_uris: ["https://atacante.example/cb"] })).status, 400);
  const ok = await A.registrarCliente(base, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  assert.equal(ok.status, 201);
  assert.match(ok.body.client_id, /^pehuen-/);
  const conf = await A.registrarCliente(base, { token_endpoint_auth_method: "client_secret_post" });
  assert.ok(conf.body.client_secret);
});

test("OAuth: errores de autorización (cliente, retorno, PKCE, clave, inactivo, pendiente, cancelar)", async () => {
  const { body: cli } = await A.registrarCliente(base);
  const { challenge } = A.pkce();
  const p = A.paramsAuth(base, cli.client_id, challenge);
  let r = await fetch(base + "/oauth/authorize?" + new URLSearchParams(Object.assign({}, p, { client_id: "no-existe" })), { redirect: "manual" });
  assert.equal(r.status, 400, "cliente desconocido no redirige");
  r = await fetch(base + "/oauth/authorize?" + new URLSearchParams(Object.assign({}, p, { redirect_uri: "https://claude.ai/otra" })), { redirect: "manual" });
  assert.equal(r.status, 400, "retorno no registrado no redirige");
  r = await fetch(base + "/oauth/authorize?" + new URLSearchParams(Object.assign({}, p, { code_challenge_method: "plain" })), { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get("location")).searchParams.get("error"), "invalid_request");
  r = await fetch(base + "/oauth/authorize?" + new URLSearchParams(p));
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await r.text(), /Crear y actualizar registros/);
  let a = await A.autorizar(base, p, { email: A.correo("admin"), clave: "mala" });
  assert.equal(a.status, 401); assert.match(a.html, /Correo o clave incorrectos/);
  a = await A.autorizar(base, p, { email: A.correo("inactivo") });
  assert.equal(a.status, 401);
  a = await A.autorizar(base, p, { email: "pendiente@pehuen-prueba.example" });
  assert.match(a.html, /pendiente de aprobación/);
  r = await A.postForm(base + "/oauth/authorize", Object.assign({}, p, { accion: "denegar" }));
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.searchParams.get("error"), "access_denied");
  assert.equal(loc.searchParams.get("state"), "estado-xyz");
});

test("OAuth: código de un solo uso, PKCE verificado y reutilización revoca los tokens", async () => {
  const { body: cli } = await A.registrarCliente(base);
  const { verifier, challenge } = A.pkce();
  const p = A.paramsAuth(base, cli.client_id, challenge);
  const a = await A.autorizar(base, p, { email: A.correo("admin") });
  const url = new URL(a.location);
  assert.equal(url.searchParams.get("state"), "estado-xyz");
  assert.equal(url.searchParams.get("iss"), base);
  const code = url.searchParams.get("code");
  const datos = { grant_type: "authorization_code", code, redirect_uri: A.REDIRECT, client_id: cli.client_id };
  assert.equal((await A.canjear(base, Object.assign({ code_verifier: "x".repeat(43) }, datos))).status, 400, "verifier incorrecto");
  const ok = await A.canjear(base, Object.assign({ code_verifier: verifier }, datos));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.token_type, "Bearer");
  assert.equal(ok.body.scope, "lectura escritura");
  assert.equal((await A.rpc(base, ok.body.access_token, "ping", {})).status, 200);
  assert.equal((await A.canjear(base, Object.assign({ code_verifier: verifier }, datos))).status, 400, "código reutilizado");
  assert.equal((await A.rpc(base, ok.body.access_token, "ping", {})).status, 401, "reutilizar el código revoca lo emitido");
});

test("OAuth: renovación con rotación; reutilizar un refresh revoca la familia", async () => {
  const c = await A.conectar(base, A.correo("admin"));
  const r1 = await A.canjear(base, { grant_type: "refresh_token", refresh_token: c.refresh, client_id: c.clientId });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refresh_token, c.refresh);
  assert.equal((await A.rpc(base, r1.body.access_token, "ping", {})).status, 200);
  const reuso = await A.canjear(base, { grant_type: "refresh_token", refresh_token: c.refresh, client_id: c.clientId });
  assert.equal(reuso.status, 400);
  assert.equal((await A.rpc(base, r1.body.access_token, "ping", {})).status, 401, "toda la familia queda revocada");
  // reducir alcance al renovar
  const c2 = await A.conectar(base, A.correo("admin"));
  const r2 = await A.canjear(base, { grant_type: "refresh_token", refresh_token: c2.refresh, client_id: c2.clientId, scope: "lectura" });
  assert.equal(r2.body.scope, "lectura");
  assert.equal((await A.canjear(base, { grant_type: "refresh_token", refresh_token: r2.body.refresh_token, client_id: c2.clientId, scope: "lectura escritura" })).status, 400, "no se puede ampliar");
});

test("OAuth: revocación RFC 7009", async () => {
  const c = await A.conectar(base, A.correo("admin"));
  const r = await fetch(base + "/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: c.token, client_id: c.clientId }) });
  assert.equal(r.status, 200);
  assert.equal((await A.rpc(base, c.token, "ping", {})).status, 401);
});

test("OAuth: mismo correo en dos empresas pide elegir y el token queda ligado a la elegida", async () => {
  const { body: cli } = await A.registrarCliente(base);
  const { challenge } = A.pkce();
  const p = A.paramsAuth(base, cli.client_id, challenge);
  const a = await A.autorizar(base, p, { email: A.correo("multi") });
  assert.equal(a.status, 200);
  assert.match(a.html, /Elige la empresa/);
  assert.match(a.html, /Andes/); assert.match(a.html, /Imaginarios/);
  assert.doesNotMatch(a.html, new RegExp(A.CLAVE), "la clave no viaja en la página");
  const c = await A.conectar(base, A.correo("multi"), { empresaId: "prueba-sur" });
  const areas = await A.herramienta(base, c.token, "listar_areas");
  assert.ok(areas.datos.every((x) => x.id.endsWith("-sur")));
});

test("OAuth: desactivar al usuario o cambiar su perfil rige de inmediato", async () => {
  const c = await A.conectar(base, A.correo("supervisor"));
  const antes = await A.rpc(base, c.token, "tools/list", {});
  assert.ok(antes.body.result.tools.some((t) => t.name === "miper_listar"));
  // quitar la vista matriz al perfil Supervisor
  const perfil = await registro("prueba-andes", "accesoPerfiles", "perfil-sup-andes");
  await pool.query("UPDATE records SET data=$1 WHERE company_id='prueba-andes' AND store='accesoPerfiles' AND id='perfil-sup-andes'", [Object.assign({}, perfil, { vistas: perfil.vistas.filter((v) => v !== "matriz") })]);
  const despues = await A.rpc(base, c.token, "tools/list", {});
  assert.ok(!despues.body.result.tools.some((t) => t.name === "miper_listar"));
  await pool.query("UPDATE records SET data=$1 WHERE company_id='prueba-andes' AND store='accesoPerfiles' AND id='perfil-sup-andes'", [perfil]);
  const u = await registro("prueba-andes", "accesoUsuarios", "usr-supervisor-andes");
  await pool.query("UPDATE records SET data=$1 WHERE company_id='prueba-andes' AND store='accesoUsuarios' AND id='usr-supervisor-andes'", [Object.assign({}, u, { activo: false })]);
  assert.equal((await A.rpc(base, c.token, "ping", {})).status, 401);
  await pool.query("UPDATE records SET data=$1 WHERE company_id='prueba-andes' AND store='accesoUsuarios' AND id='usr-supervisor-andes'", [u]);
});

// ======================= Protocolo MCP =======================
test("MCP: initialize, notificaciones, ping, errores de protocolo y origen", async () => {
  const t = tokens.admin;
  const ini = await A.rpc(base, t, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prueba", version: "1" } });
  assert.equal(ini.body.result.protocolVersion, "2025-06-18");
  assert.ok(ini.body.result.capabilities.tools);
  assert.equal((await A.rpc(base, t, "initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion, "2025-11-25");
  const n = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(n.status, 202);
  assert.deepEqual((await A.rpc(base, t, "ping", {})).body.result, {});
  assert.equal((await A.rpc(base, t, "no/existe", {})).body.error.code, -32601);
  const lote = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t }, body: "[]" });
  assert.equal(lote.status, 400);
  assert.equal((await fetch(base + "/mcp", { headers: { authorization: "Bearer " + t } })).status, 405);
  assert.equal((await A.rpc(base, t, "ping", {}, { origin: "https://sitio-malicioso.example" })).status, 403);
  assert.equal((await A.rpc(base, t, "ping", {}, { origin: "https://claude.ai" })).status, 200);
  assert.equal((await A.rpc(base, t, "tools/call", { name: "no_existe", arguments: {} })).body.error.code, -32602);
});

test("Conexión actual: empresa, usuario y perfil; las escrituras dicen dónde se guardaron", async () => {
  const c = await H("supervisor", "conexion_actual", {});
  assert.equal(c.datos.empresa.nombre, "Constructora Ficticia Andes SpA (PRUEBA)");
  assert.equal(c.datos.usuario.nombre, "Sergio Supervisor Inventado");
  assert.equal(c.datos.perfil.nombre, "Jefe de Obra / Supervisor");
  assert.equal(c.datos.permisos.escritura, true);
  assert.equal(c.datos.modulos.find((m) => m.modulo === "Control documental").acceso, false);
  const sur = await H("sur", "conexion_actual", {});
  assert.equal(sur.datos.empresa.id, "prueba-sur");
  const ini = await A.rpc(base, tokens.lectura, "initialize", { protocolVersion: "2025-06-18" });
  assert.match(ini.body.result.instructions, /^Conectado a la empresa «Constructora Ficticia Andes SpA \(PRUEBA\)» como Pía Prevención Ficticia \(perfil Prevencionista de Riesgos\), solo lectura\./);
  const w = await H("admin", "trabajador_crear", { nombre: "Prueba Empresa En Respuesta", area: "Oficina" });
  assert.equal(w.datos.empresa, "Constructora Ficticia Andes SpA (PRUEBA)");
  assert.match(w.datos.mensaje, /\(Empresa: Constructora Ficticia Andes SpA \(PRUEBA\)\)$/);
  const l = await H("admin", "listar_areas", {});
  assert.ok(Array.isArray(l.datos), "las lecturas no cambian de forma");
});

test("MCP: ninguna herramienta elimina y todas declaran destructiveHint=false", async () => {
  const { tools } = (await A.rpc(base, tokens.admin, "tools/list", {})).body.result;
  assert.ok(tools.length >= 40);
  for (const t of tools) {
    assert.doesNotMatch(t.name, /elimin|borr|delete|remove|quitar/i);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.inputSchema.type, "object");
  }
});

// ======================= Permisos =======================
async function nombres(rol) { return new Set((await A.rpc(base, tokens[rol], "tools/list", {})).body.result.tools.map((t) => t.name)); }
test("Permisos: cada perfil ve solo los módulos de su perfil en la app", async () => {
  const admin = await nombres("admin");
  for (const n of ["auditoria_listar", "trabajador_crear", "miper_aceptar_riesgo_medio", "documento_crear"]) assert.ok(admin.has(n), n);
  const prev = await nombres("prevencionista");
  assert.ok(prev.has("miper_aceptar_riesgo_medio") && prev.has("documentos_vencidos") && prev.has("trabajadores_listar"));
  assert.ok(!prev.has("trabajador_crear"), "sin vista config no escribe trabajadores");
  assert.ok(!prev.has("auditoria_listar"));
  const sup = await nombres("supervisor");
  assert.ok(sup.has("miper_crear_linea") && sup.has("programa_avance") && sup.has("capacitaciones_listar"));
  assert.ok(!sup.has("documentos_listar"), "supervisor no ve Control documental");
  assert.ok(!sup.has("miper_aceptar_riesgo_medio"), "supervisor no acepta riesgos");
  assert.deepEqual([...(await nombres("trabajador"))], ["conexion_actual"], "perfil Trabajador: solo puede ver con qué empresa está conectado");
  const cap = await nombres("capacitacion");
  assert.ok(cap.has("capacitaciones_por_vencer") && cap.has("trabajadores_listar") && cap.has("buscar"));
  assert.ok(!cap.has("miper_listar") && !cap.has("programa_listar"));
  const lect = await nombres("lectura");
  assert.ok(lect.has("miper_listar") && !lect.has("miper_crear_linea"), "alcance lectura oculta escrituras");
});

test("Permisos: llamar una herramienta no permitida devuelve error y no escribe", async () => {
  const antes = await conteos();
  let r = await H("supervisor", "documentos_listar", {});
  assert.equal(r.error, true); assert.match(r.texto, /no tiene acceso/);
  r = await H("lectura", "trabajador_crear", { nombre: "X", area: "Taller" });
  assert.equal(r.error, true);
  r = await H("lectura", "miper_crear_linea", { area: "Taller", actividad: "a", peligro: "b", riesgo: "c", probabilidad: 3, consecuencia: 3, simbolo_oficial: "seg-caida-mismo-nivel" });
  assert.match(r.texto, /solo para lectura/);
  r = await H("prevencionista", "trabajador_crear", { nombre: "X", area: "Taller" });
  assert.equal(r.error, true);
  assert.deepEqual(await conteos(), antes);
});

test("Aislamiento: una empresa no puede ver ni escribir datos de otra", async () => {
  let r = await H("admin", "miper_detalle", { id: "miper-1-sur" });
  assert.equal(r.error, true);
  r = await H("admin", "buscar", { texto: "Ejemplo" });
  assert.ok(r.datos.trabajadores.resultados.every((t) => !String(t.id).endsWith("-sur")));
  r = await H("sur", "trabajador_actualizar", { id: "trab-1-andes", version_esperada: "x", nombre: "Hackeado" });
  assert.equal(r.error, true);
  assert.equal((await registro("prueba-andes", "trabajadores", "trab-1-andes")).nombre, "Ana Ejemplo Uno");
  r = await H("sur", "miper_crear_linea", { area_id: "area-taller-andes", actividad: "a", peligro: "b", riesgo: "c", probabilidad: 3, consecuencia: 3, simbolo_oficial: "seg-caida-mismo-nivel" });
  assert.equal(r.error, true); assert.match(r.texto, /No existe el área/);
});

// ======================= MIPER =======================
test("MIPER: lectura (listar, filtros, detalle, críticos, resumen, catálogos)", async () => {
  const l = await H("prevencionista", "miper_listar", {});
  assert.equal(l.datos.total, 6);
  assert.equal(l.datos.resultados[0].nivelEfectivo, "Muy alto", "ordenado de mayor a menor");
  assert.equal((await H("prevencionista", "miper_listar", { area: "terreno" })).datos.total, 2);
  const residual = (await H("prevencionista", "miper_listar", { texto: "conductor" })).datos.resultados[0];
  assert.equal(residual.nivelPuro, "Muy alto"); assert.equal(residual.nivelEfectivo, "Muy alto"); // P1 x C5 sigue Muy alto
  const det = await H("prevencionista", "miper_detalle", { id: "miper-1-andes" });
  assert.equal(det.datos.controles.length, 2);
  assert.equal(det.datos.acciones[0].estado, "atrasada");
  assert.ok(det.datos.linea._version);
  const crit = await H("prevencionista", "miper_riesgos_criticos", { incluir_altos: false });
  assert.deepEqual(crit.datos.resultados.map((x) => x.id).sort(), ["miper-2-andes", "miper-3-andes"]);
  const res = await H("prevencionista", "miper_resumen", {});
  assert.equal(res.datos.totalLineas, 6);
  assert.equal(res.datos.riesgosMedioAceptados, 1);
  assert.equal(res.datos.aceptacionesPorVencer30Dias, 1);
  assert.equal(res.datos.accionesDelPlan.atrasada, 1);
  assert.equal(res.datos.residualPorEvaluar, 1); // miper-6: con controles, Medio, sin residual ni acciones
  const cat = await H("prevencionista", "miper_catalogos", {});
  assert.equal(cat.datos.simbolosOficiales.length, 34);
  assert.ok(cat.datos.sugerencias.peligro.length > 10);
});

test("MIPER: crear línea con las validaciones de la app, historial, catálogo y auditoría", async () => {
  const baseLinea = { area: "Taller", actividad: "Soldadura al arco", peligro: "Radiación no ionizante de prueba", riesgo: "Quemadura ocular", probabilidad: 4, consecuencia: 3 };
  let r = await H("supervisor", "miper_crear_linea", Object.assign({}, baseLinea, { simbolo_oficial: undefined }));
  assert.equal(r.error, true); assert.match(r.texto, /simbolo_oficial: es obligatorio/);
  const conDetalle = (await H("supervisor", "miper_catalogos", {})).datos.simbolosOficiales.find((s) => s.requiereEspecificar);
  r = await H("supervisor", "miper_crear_linea", Object.assign({}, baseLinea, { simbolo_oficial: conDetalle.id }));
  assert.equal(r.error, true); assert.match(r.texto, /requiere especificar el detalle/);
  r = await H("supervisor", "miper_crear_linea", Object.assign({}, baseLinea, { simbolo_oficial: "seg-caida-mismo-nivel", sensible: true }));
  assert.match(r.texto, /al menos un grupo/);
  r = await H("supervisor", "miper_crear_linea", Object.assign({}, baseLinea, { simbolo_oficial: "seg-caida-mismo-nivel", probabilidad: 6 }));
  assert.match(r.texto, /máximo 5/);
  r = await H("supervisor", "miper_crear_linea", Object.assign({}, baseLinea, {
    simbolo_oficial: conDetalle.id, simbolo_detalle: "Radiación UV de soldadura", sensible: true, grupos_sensibles: ["Persona migrante"],
    controles: [{ jerarquia: "E", texto: "Careta de soldar" }, { jerarquia: "D", texto: "Procedimiento de trabajo en altura", responsable: "Pía" }],
  }));
  assert.equal(r.error, false, r.texto);
  const id = r.datos.linea.id;
  const guardado = await registro("prueba-andes", "matriz", id);
  assert.equal(guardado.estado, "pendiente");
  assert.equal(guardado.controles, "• E) Careta de soldar\n• D) Procedimiento de trabajo en altura");
  assert.equal(guardado.responsable, "• D) Pía");
  assert.equal(guardado.controlesJerarquizados[1].documentoId, "doc-3-andes", "vincula el procedimiento con el mismo nombre");
  assert.equal(guardado.simboloDetalle, "Radiación UV de soldadura");
  const hist = (await pool.query("SELECT data FROM records WHERE company_id='prueba-andes' AND store='matrizHistorial' AND data->>'registroId'=$1", [id])).rows;
  assert.equal(hist.length, 1); assert.equal(hist[0].data.campo, "Línea creada");
  const cat = await pool.query("SELECT 1 FROM catalogos_rubro WHERE rubro_norm='construccion' AND tipo='peligro' AND valor=$1", [baseLinea.peligro]);
  assert.equal(cat.rowCount, 1, "peligro nuevo queda en el catálogo del rubro");
  const aud = await auditoria("registro_id=$1 AND store='matriz'", [id]);
  assert.equal(aud.length, 1);
  assert.equal(aud[0].operacion, "crear");
  assert.equal(aud[0].usuario_id, "usr-supervisor-andes");
  assert.equal(aud[0].usuario_nombre, "Sergio Supervisor Inventado");
  assert.equal(aud[0].herramienta, "miper_crear_linea");
  assert.equal(aud[0].valor_anterior, null);
  assert.equal(aud[0].valor_nuevo.actividad, "Soldadura al arco");
});

test("MIPER: actualizar exige versión, detecta conflictos y registra cada campo cambiado", async () => {
  const det = (await H("prevencionista", "miper_detalle", { id: "miper-5-andes" })).datos;
  let r = await H("prevencionista", "miper_actualizar_linea", { id: "miper-5-andes", probabilidad: 4 });
  assert.match(r.texto, /version_esperada: es obligatorio/);
  r = await H("prevencionista", "miper_actualizar_linea", { id: "miper-5-andes", version_esperada: "2000-01-01T00:00:00.000Z", probabilidad: 4 });
  assert.match(r.texto, /modificado por otra persona/);
  r = await H("prevencionista", "miper_actualizar_linea", { id: "miper-5-andes", version_esperada: det.linea._version, probabilidad: 4, consecuencia: 3, riesgo: "Contusión grave" });
  assert.equal(r.error, false, r.texto);
  assert.deepEqual(r.datos.camposCambiados.sort(), ["Consecuencia", "Probabilidad", "Riesgo asociado"]);
  assert.equal(r.datos.niveles.nivelEfectivo, "Alto");
  const aud = (await auditoria("registro_id='miper-5-andes' AND store='matriz'")).pop();
  assert.equal(aud.operacion, "actualizar");
  assert.equal(aud.valor_anterior.probabilidad, 2);
  assert.equal(aud.valor_nuevo.probabilidad, 4);
  assert.deepEqual(aud.campos_cambiados.sort(), ["consecuencia", "probabilidad", "riesgo"]);
  // la versión anterior ya no sirve
  r = await H("prevencionista", "miper_actualizar_linea", { id: "miper-5-andes", version_esperada: det.linea._version, probabilidad: 5 });
  assert.match(r.texto, /modificado por otra persona/);
  // vaciar un campo obligatorio se rechaza
  r = await H("prevencionista", "miper_actualizar_linea", { id: "miper-5-andes", version_esperada: (await H("prevencionista", "miper_detalle", { id: "miper-5-andes" })).datos.linea._version, peligro: " " });
  assert.match(r.texto, /Complete área, actividad, peligro y riesgo/);
});

test("Plan de acción: crear (riesgo Medio o más), grupo, estado y cumplimiento con reevaluación del residual", async () => {
  let r = await H("prevencionista", "plan_accion_crear", { matriz_id: "miper-1-sur", actividad: "x", responsable: "y", plazo: "2026-12-01" });
  assert.equal(r.error, true);
  // miper-5 ahora es Alto; miper-6 es Medio
  r = await H("prevencionista", "plan_accion_crear", { matriz_id: "miper-6-andes", otras_lineas: ["miper-5-andes"], actividad: "Señalizar zonas de acopio", responsable: "Sergio Supervisor Inventado", plazo: "2026-12-15", tipo_accion: "mitigar" });
  assert.equal(r.error, false, r.texto);
  assert.equal(r.datos.acciones.length, 2);
  const [a1, a2] = await Promise.all(r.datos.acciones.map((x) => registro("prueba-andes", "planAccionMatriz", x.id)));
  assert.ok(a1.grupoId && a1.grupoId === a2.grupoId);
  assert.equal(a1.ronda, 1); assert.equal(a1.probAntes, 3); assert.equal(a1.consAntes, 3);
  r = await H("prevencionista", "plan_accion_crear", { matriz_id: "miper-6-andes", actividad: "", responsable: "y", plazo: "2026-12-01" });
  assert.match(r.texto, /no puede estar vacío/);
  r = await H("prevencionista", "plan_accion_cambiar_estado", { ids: [a1.id], estado: "proceso" });
  assert.equal(r.error, false);
  assert.equal((await registro("prueba-andes", "planAccionMatriz", a1.id)).estado, "proceso");
  // aceptar la línea 4 (Medio aceptado) y luego cumplir una acción sobre ella revoca la aceptación
  r = await H("prevencionista", "plan_accion_crear", { matriz_id: "miper-4-andes", actividad: "Silla ergonómica", responsable: "Elena", plazo: "2026-12-01" });
  const idAcc = r.datos.acciones[0].id;
  r = await H("prevencionista", "plan_accion_marcar_cumplida", { ids: [idAcc], probabilidad_despues: 1, consecuencia_despues: 2, observacion: "Sillas instaladas" });
  assert.equal(r.error, false, r.texto);
  assert.match(r.datos.siguientePaso, /controlado/);
  const m4 = await registro("prueba-andes", "matriz", "miper-4-andes");
  assert.equal(m4.probabilidadResidual, 1); assert.equal(m4.consecuenciaResidual, 2);
  assert.equal(m4.aceptacionRiesgo.revocada, true);
  assert.equal(m4.aceptacionRiesgo.revocadaMotivo, "Nueva evaluación del riesgo residual");
  const acc = await registro("prueba-andes", "planAccionMatriz", idAcc);
  assert.equal(acc.estado, "cumplida"); assert.equal(acc.probDespues, 1); assert.equal(acc.eficaciaObservacion, "Sillas instaladas");
  r = await H("prevencionista", "plan_accion_marcar_cumplida", { ids: [idAcc], probabilidad_despues: 1, consecuencia_despues: 1 });
  assert.match(r.texto, /ya está cumplida/);
  r = await H("prevencionista", "plan_accion_crear", { matriz_id: "miper-4-andes", actividad: "x", responsable: "y", plazo: "2026-12-01" });
  assert.match(r.texto, /riesgo Bajo/);
  const hist = (await pool.query("SELECT data->>'campo' c FROM records WHERE company_id='prueba-andes' AND store='matrizHistorial' AND data->>'registroId'='miper-4-andes'")).rows.map((x) => x.c);
  assert.ok(hist.includes("Riesgo residual (acción cumplida)") && hist.includes("Estado del plan de acción") && hist.includes("Plan de acción"));
});

test("MIPER: aceptar y revocar riesgo Medio solo con permiso y con las reglas de la app", async () => {
  let r = await H("supervisor", "miper_aceptar_riesgo_medio", { matriz_id: "miper-6-andes", justificacion: "x" });
  assert.match(r.texto, /no tiene acceso/);
  r = await H("prevencionista", "miper_aceptar_riesgo_medio", { matriz_id: "miper-5-andes", justificacion: "x" });
  assert.match(r.texto, /nivel Medio/);
  r = await H("prevencionista", "miper_aceptar_riesgo_medio", { matriz_id: "miper-6-andes", justificacion: "x", revisar_en: hoyChile() });
  assert.match(r.texto, /posterior a hoy/);
  r = await H("prevencionista", "miper_aceptar_riesgo_medio", { matriz_id: "miper-6-andes", justificacion: "Controles razonables aplicados." });
  assert.equal(r.error, false, r.texto);
  const m = await registro("prueba-andes", "matriz", "miper-6-andes");
  assert.equal(m.aceptacionRiesgo.por, "Pía Prevención Ficticia");
  assert.equal(m.aceptacionRiesgo.nivel, "medio");
  r = await H("prevencionista", "miper_revocar_aceptacion", { matriz_id: "miper-6-andes" });
  assert.equal(r.error, false);
  assert.equal((await registro("prueba-andes", "matriz", "miper-6-andes")).aceptacionRiesgo.revocada, true);
  r = await H("prevencionista", "miper_revocar_aceptacion", { matriz_id: "miper-6-andes" });
  assert.match(r.texto, /no tiene una aceptación/);
});

// ======================= Programa =======================
test("Programa: lectura, avance, personas, crear con hoja mensual, actualizar y realización", async () => {
  const l = await H("supervisor", "programa_listar", {});
  assert.equal(l.datos.total, 5);
  assert.equal((await H("supervisor", "programa_listar", { estado: "atrasada" })).datos.total, 2);
  const av = await H("supervisor", "programa_avance", {});
  assert.equal(av.datos.total.programadas, 5); assert.equal(av.datos.total.realizadas, 2); assert.equal(av.datos.total.porcentaje, 40);
  assert.equal(av.datos.atrasadas.length, 2);
  let r = await H("supervisor", "programa_crear_actividad", { nombre: "Inspección de andamios", tipo: "inspeccion", area: "Terreno", responsable: "Persona Inexistente", fecha_programada: "2027-03-10" });
  assert.match(r.texto, /no está en «Personas del programa»/);
  r = await H("supervisor", "programa_crear_actividad", { nombre: "Inspección de andamios", tipo: "inspeccion", responsable: "Pía Prevención Ficticia", fecha_programada: "2027-03-10" });
  assert.match(r.texto, /Debes indicar el área/);
  r = await H("supervisor", "programa_crear_actividad", { nombre: "Inspección de andamios", tipo: "inspeccion", area: "Terreno", responsable: "pia prevencion ficticia", fecha_programada: "2027-03-10" });
  assert.equal(r.error, false, r.texto);
  assert.equal(r.datos.actividad.responsable, "Pía Prevención Ficticia", "normaliza al nombre de la persona");
  assert.match(r.datos.mensaje, /hoja mensual/);
  const hojas = (await pool.query("SELECT data FROM records WHERE company_id='prueba-andes' AND store='programaCargo' AND (data->>'anio')::int=2027 AND (data->>'mes')::int=3")).rows;
  assert.equal(hojas.length, 1); assert.equal(hojas[0].data.personaId, "per-1-andes");
  const id = r.datos.actividad.id;
  const det = (await H("supervisor", "programa_detalle", { id })).datos;
  r = await H("supervisor", "programa_actualizar_actividad", { id, version_esperada: det._version, fecha_programada: "2027-03-20", responsable: "Sergio Supervisor Inventado" });
  assert.equal(r.error, false, r.texto);
  r = await H("supervisor", "programa_registrar_realizacion", { id, fecha_realizada: "2027-03-20" });
  assert.equal(r.datos.estado, "realizada");
  await pool.query("UPDATE records SET data = data || '{\"documento\":\"data:application/pdf;base64,AAAA\",\"documentoNombre\":\"acta.pdf\"}' WHERE company_id='prueba-andes' AND store='programa' AND id=$1", [id]);
  r = await H("supervisor", "programa_registrar_realizacion", { id, fecha_realizada: null });
  const p = await registro("prueba-andes", "programa", id);
  assert.equal(p.fechaRealizada, null);
  assert.equal(p.documentoNombre, "acta.pdf", "el conector no borra el respaldo");
});

// ======================= Capacitación =======================
test("Capacitación: por vencer, crear dirigida por cargos, asistencia y curso obligatorio", async () => {
  const pv = await H("capacitacion", "capacitaciones_por_vencer", {});
  const det = pv.datos.cursosObligatorios.detalle;
  assert.ok(det.some((x) => x.trabajadorId === "trab-1-andes" && x.estado === "Vencido" && x.curso === "Capacitación general del trabajador"));
  assert.ok(det.some((x) => x.trabajadorId === "trab-2-andes" && x.estado === "Próximo a vencer"));
  assert.ok(det.some((x) => x.trabajadorId === "trab-1-andes" && x.curso === "Capacitación Comité Paritario" && x.estado === "Nunca completado"), "aplica por rol y tramo (>25)");
  assert.ok(!det.some((x) => x.trabajadorId === "trab-3-andes" && x.curso === "Capacitación general del trabajador"), "vigente no aparece");
  assert.equal(pv.datos.capacitacionesDelPlan.atrasadas, 1);
  const pvSur = await H("sur", "capacitaciones_por_vencer", {});
  assert.ok(!pvSur.datos.cursosObligatorios.detalle.some((x) => x.curso === "Capacitación Comité Paritario"), "empresa de 8 trabajadores no exige comité");
  let r = await H("capacitacion", "capacitacion_crear", { nombre: "Trabajo con energía", fecha_programada: "2027-01-15", dirigida_a: { tipo: "cargos", cargos: [] } });
  assert.match(r.texto, /al menos un cargo/);
  r = await H("capacitacion", "capacitacion_crear", { nombre: "Trabajo con energía", fecha_programada: "2027-01-15", tipo: "Tipo inventado" });
  assert.match(r.texto, /Tipo de capacitación no válido/);
  r = await H("capacitacion", "capacitacion_crear", { nombre: "Trabajo con energía", fecha_programada: "2027-01-15", tipo: "obligatoria ds 44", horas: 3, relator: "Pía Prevención Ficticia", dirigida_a: { tipo: "cargos", cargos: ["liniero"] } });
  assert.equal(r.error, false, r.texto);
  assert.equal(r.datos.capacitacion.convocados, 2);
  assert.equal(r.datos.capacitacion.tipo, "Obligatoria DS 44");
  const id = r.datos.capacitacion.id;
  r = await H("capacitacion", "capacitacion_registrar_asistencia", { id, registros: [{ trabajador_id: "trab-3-andes", asistio: true, aprobado: true }, { trabajador_id: "trab-6-andes" }] });
  assert.equal(r.error, false, r.texto);
  assert.equal(r.datos.capacitacion.asistieron, 2, "trabajador agregado queda como asistente");
  assert.equal(r.datos.capacitacion.estado, "realizada");
  const c = await registro("prueba-andes", "capacitaciones", id);
  assert.equal(c.realizadaAuto, true);
  const det2 = (await H("capacitacion", "capacitacion_detalle", { id })).datos;
  r = await H("capacitacion", "capacitacion_actualizar", { id, version_esperada: det2._version, dirigida_a: { tipo: "personas", personas_ids: ["trab-1-andes"] } });
  assert.equal(r.error, false, r.texto);
  assert.deepEqual(r.datos.capacitacion.convocados, 3, "conserva asistentes, suma la persona y quita al no asistente");
  r = await H("capacitacion", "trabajador_curso_registrar", { trabajador_id: "trab-1-andes", curso_id: "curso-general-andes", fecha_aprobacion: "2026-10-01" });
  assert.equal(r.datos.fechaVencimiento, "2028-10-01");
  const pv2 = await H("capacitacion", "capacitaciones_por_vencer", { trabajador_id: "trab-1-andes" });
  assert.ok(!pv2.datos.cursosObligatorios.detalle.some((x) => x.curso === "Capacitación general del trabajador"), "el registro más reciente lo deja vigente");
});

// ======================= Documentos =======================
test("Documentos: vigentes, vencidos según el criterio acordado, crear versión y actualizar sin perder el archivo", async () => {
  const l = await H("prevencionista", "documentos_listar", {});
  assert.equal(l.datos.total, 4, "solo vigentes por defecto (la política v1 queda en el historial)");
  assert.equal((await H("prevencionista", "documentos_listar", { solo_vigentes: false })).datos.total, 5);
  const v = await H("prevencionista", "documentos_vencidos", {});
  assert.deepEqual(v.datos.vencidos.map((d) => d.id), ["doc-3-andes"]);
  assert.deepEqual(v.datos.sinFechas.map((d) => d.id), ["doc-5-andes"]);
  const det = await H("prevencionista", "documento_detalle", { id: "doc-3-andes" });
  assert.ok(det.datos.lineasMiper.some((x) => x.id === "miper-2-andes"));
  assert.equal(det.datos.versiones.length, 1);
  let r = await H("prevencionista", "documento_crear", { tipo: "procedimiento", nombre: "Procedimiento de trabajo en altura", version: "" });
  assert.match(r.texto, /no puede estar vacío/);
  r = await H("prevencionista", "documento_crear", { tipo: "procedimiento", nombre: "Procedimiento de trabajo en altura", version: "2", fecha_actualizacion: hoyChile(), fecha_revision: "2027-11-01" });
  assert.equal(r.error, false, r.texto);
  assert.equal(r.datos.documento.versionVigente, true);
  assert.equal(r.datos.documento.subtipo, "Procedimiento de trabajo seguro");
  assert.equal((await H("prevencionista", "documentos_vencidos", {})).datos.vencidos.length, 0, "la nueva versión reemplaza a la vencida");
  // un archivo adjunto no se devuelve ni se pierde al actualizar, y la auditoría guarda solo su hash
  const archivo = "data:application/pdf;base64," + "B".repeat(1000);
  await pool.query("UPDATE records SET data = jsonb_set(data, '{archivoData}', to_jsonb($1::text)) WHERE company_id='prueba-andes' AND store='documentos' AND id='doc-4-andes'", [archivo]);
  const d4 = await H("prevencionista", "documento_detalle", { id: "doc-4-andes" });
  assert.equal(d4.datos.tieneArchivo, true);
  assert.doesNotMatch(d4.texto, /BBBB/);
  r = await H("prevencionista", "documento_actualizar", { id: "doc-4-andes", version_esperada: d4.datos._version, observaciones: "Revisado con Claude" });
  assert.equal(r.error, false, r.texto);
  assert.equal((await registro("prueba-andes", "documentos", "doc-4-andes")).archivoData, archivo);
  const aud = (await auditoria("registro_id='doc-4-andes'")).pop();
  assert.equal(aud.valor_nuevo.archivoData.adjuntoOmitido, true);
  assert.equal(aud.valor_nuevo.archivoData.bytes, archivo.length);
  assert.deepEqual(aud.campos_cambiados, ["observaciones"]);
});

// ======================= Trabajadores =======================
test("Trabajadores: lectura con cualquier módulo, escritura solo con Configuración", async () => {
  const l = await H("capacitacion", "trabajadores_listar", { cargo: "liniero" });
  assert.equal(l.datos.total, 2);
  assert.ok(l.datos.resultados[0].rut, "el RUT se muestra (acordado)");
  const det = await H("capacitacion", "trabajador_detalle", { id: "trab-1-andes" });
  assert.ok(det.datos.cursosObligatorios.length >= 1);
  let r = await H("admin", "trabajador_crear", { nombre: "Gabriela Ejemplo Siete", rut: "0.000.001-0", cargo: "Maestro" });
  assert.match(r.texto, /Debes indicar el área/);
  r = await H("admin", "trabajador_crear", { nombre: "Gabriela Ejemplo Siete", rut: "0.000.001-0", cargo: "Maestro", area: "Taller", roles: ["delegado"] });
  assert.equal(r.error, false, r.texto);
  assert.match(r.datos.aviso, /Ya existe otro trabajador con el RUT/);
  const id = r.datos.trabajador.id;
  const d = (await H("admin", "trabajador_detalle", { id })).datos;
  r = await H("admin", "trabajador_actualizar", { id, version_esperada: d._version, rut: "0.000.007-0", roles: [] });
  assert.equal(r.error, false);
  assert.deepEqual((await registro("prueba-andes", "trabajadores", id)).roles, []);
});

// ======================= Auditoría y compatibilidad con la app =======================
test("Auditoría: cada escritura del conector quedó registrada y solo el admin la consulta", async () => {
  const aud = await auditoria("company_id='prueba-andes'");
  const herramientasUsadas = new Set(aud.map((a) => a.herramienta));
  for (const h of ["miper_crear_linea", "miper_actualizar_linea", "plan_accion_crear", "plan_accion_cambiar_estado", "plan_accion_marcar_cumplida", "miper_aceptar_riesgo_medio", "miper_revocar_aceptacion", "programa_crear_actividad", "programa_actualizar_actividad", "programa_registrar_realizacion", "capacitacion_crear", "capacitacion_actualizar", "capacitacion_registrar_asistencia", "trabajador_curso_registrar", "documento_crear", "documento_actualizar", "trabajador_crear", "trabajador_actualizar"]) {
    assert.ok(herramientasUsadas.has(h), "sin auditoría: " + h);
  }
  assert.ok(aud.every((a) => a.usuario_id && a.momento && a.store && a.registro_id && a.valor_nuevo && a.client_id));
  // Toda fila de records escrita por el conector tiene su auditoría
  const { rows } = await pool.query(`SELECT count(*)::int n FROM auditoria_escrituras a LEFT JOIN records r ON r.company_id=a.company_id AND r.store=a.store AND r.id=a.registro_id WHERE r.id IS NULL`);
  assert.equal(rows[0].n, 0, "no hay auditorías de registros inexistentes (nada se borró)");
  const r = await H("admin", "auditoria_listar", { store: "matriz", limite: 5, incluir_valores: true });
  assert.ok(r.datos.length > 0 && r.datos[0].valor_nuevo);
  assert.match(r.datos[0].momento, /^\d{4}-\d{2}-\d{2}T/, "la fecha de la auditoría se muestra");
  assert.equal((await H("prevencionista", "auditoria_listar", {})).error, true);
  assert.equal((await H("sur", "auditoria_listar", {})).datos.filter((a) => a.store === "matriz").length, 0, "la auditoría también está aislada por empresa");
});

test("Compatibilidad: lo creado por el conector se lee igual desde la API de la app", async () => {
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: A.correo("admin"), clave: A.CLAVE }) });
  const { token } = await login.json();
  const matriz = await (await fetch(base + "/api/matriz", { headers: { authorization: "Bearer " + token } })).json();
  const nueva = matriz.find((m) => m.actividad === "Soldadura al arco");
  assert.ok(nueva, "la línea creada por el conector aparece en la app");
  assert.equal(nueva._version, undefined, "no se filtra el campo interno _version a los datos");
  // y el token de la app no sirve para el conector ni viceversa
  assert.equal((await A.rpc(base, token, "ping", {})).status, 401);
  assert.equal((await fetch(base + "/api/matriz", { headers: { authorization: "Bearer " + tokens.admin } })).status, 401);
});

test("OAuth: bloquea tras 10 intentos fallidos con el mismo correo", async () => {
  const { body: cli } = await A.registrarCliente(base);
  const p = A.paramsAuth(base, cli.client_id, A.pkce().challenge);
  for (let i = 0; i < 10; i++) assert.equal((await A.autorizar(base, p, { email: A.correo("admin", "sur"), clave: "mala" + i })).status, 401);
  const r = await A.autorizar(base, p, { email: A.correo("admin", "sur") }); // clave correcta, pero bloqueado
  assert.equal(r.status, 429);
  assert.equal((await A.autorizar(base, p, { email: A.correo("supervisor", "sur") })).status, 302, "otro correo desde la misma IP sigue entrando");
});
