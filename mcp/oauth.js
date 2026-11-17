"use strict";
// Servidor de autorización OAuth 2.1 del conector MCP, ligado a los
// usuarios (accesoUsuarios) y empresas que ya existen en la app.
//
//  - Descubrimiento: RFC 9728 (recurso protegido) y RFC 8414 (servidor).
//  - Registro dinámico de clientes: RFC 7591, solo con URLs de retorno
//    permitidas (por defecto, únicamente la de claude.ai).
//  - Código de autorización con PKCE S256 obligatorio, un solo uso.
//  - Tokens opacos, guardados solo como hash; acceso 1 h, renovación 30
//    días con rotación y detección de reutilización (revoca la familia).
//  - Revocación: RFC 7009.

const crypto = require("crypto");
const { sha256, tokenAleatorio } = require("./util");
const paginas = require("./paginas");
const { empresaHabilitada } = require("./contexto");

const ALCANCES = ["lectura", "escritura"];
const TTL_ACCESO_S = 3600;
const TTL_RENOVACION_S = 30 * 24 * 3600;
const TTL_CODIGO_S = 600;
const REDIRECTS_POR_DEFECTO = ["https://claude.ai/api/mcp/auth_callback"];

function crearOAuth(deps) {
  const { pool, dbFindUsuariosPorEmail, dbGetEmpresa, verifyPassword, secreto } = deps;
  const redirectsPermitidos = (process.env.MCP_REDIRECT_URIS || REDIRECTS_POR_DEFECTO.join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);
  // La CSP form-action también se aplica a la redirección que sigue al
  // envío del formulario, así que debe incluir el origen de cada retorno.
  const origenesRetorno = [...new Set(redirectsPermitidos.map((u) => new URL(u).origin))].join(" ");
  const html = (res, status, cuerpo) => enviarHtml(res, status, cuerpo, origenesRetorno);

  // ---------- límite de intentos (memoria, como el registro público) ----------
  // Solo cuentan los intentos FALLIDOS: muchas personas de una misma oficina
  // (misma IP) pueden conectar Claude sin bloquearse entre sí.
  const intentos = new Map();
  function recientes(clave, ventanaMs) {
    const ahora = Date.now();
    const lista = (intentos.get(clave) || []).filter((t) => ahora - t < ventanaMs);
    intentos.set(clave, lista);
    return lista;
  }
  function bloqueado(clave, max, ventanaMs) { return recientes(clave, ventanaMs).length >= max; }
  function anotarFallo(clave, ventanaMs) {
    recientes(clave, ventanaMs).push(Date.now());
    if (intentos.size > 10000) intentos.clear();
  }
  // Para el token: cuenta todas las solicitudes (no hay "fallo" de usuario).
  function permitir(clave, max, ventanaMs) {
    if (bloqueado(clave, max, ventanaMs)) return false;
    anotarFallo(clave, ventanaMs);
    return true;
  }
  const VENTANA_LOGIN_MS = 15 * 60 * 1000;
  const MAX_FALLOS_IP = +process.env.MCP_MAX_FALLOS_IP || 20;
  const MAX_FALLOS_CORREO = +process.env.MCP_MAX_FALLOS_CORREO || 10;
  function ipDe(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "?"; }

  // ---------- URLs públicas ----------
  function baseUrl(req) {
    const conf = process.env.MCP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
    if (conf) return conf.replace(/\/+$/, "");
    const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    return `${proto}://${req.headers.host}`;
  }
  function recursoUrl(req) { return baseUrl(req) + "/mcp"; }
  function recursoCoincide(req, resource) {
    if (!resource) return true;
    const norm = (u) => String(u).replace(/\/+$/, "");
    return norm(resource) === norm(recursoUrl(req));
  }

  function metadatosRecurso(req) {
    return {
      resource: recursoUrl(req),
      authorization_servers: [baseUrl(req)],
      scopes_supported: ALCANCES,
      bearer_methods_supported: ["header"],
      resource_name: "Prevención de Riesgos Pehuén",
    };
  }
  function metadatosServidor(req) {
    const b = baseUrl(req);
    return {
      issuer: b,
      authorization_endpoint: b + "/oauth/authorize",
      token_endpoint: b + "/oauth/token",
      registration_endpoint: b + "/oauth/register",
      revocation_endpoint: b + "/oauth/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ALCANCES,
      authorization_response_iss_parameter_supported: true,
    };
  }

  // ---------- registro dinámico de clientes ----------
  async function registrar(body) {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length) return [400, { error: "invalid_redirect_uri", error_description: "Debes indicar redirect_uris." }];
    const noPermitidas = uris.filter((u) => !redirectsPermitidos.includes(u));
    if (noPermitidas.length) return [400, { error: "invalid_redirect_uri", error_description: `URL de retorno no permitida: ${noPermitidas.join(", ")}` }];
    const metodo = body.token_endpoint_auth_method || "none";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(metodo)) return [400, { error: "invalid_client_metadata", error_description: "token_endpoint_auth_method no soportado." }];
    const grants = body.grant_types || ["authorization_code", "refresh_token"];
    if (grants.some((g) => !["authorization_code", "refresh_token"].includes(g))) return [400, { error: "invalid_client_metadata", error_description: "grant_types no soportado." }];
    const clientId = "pehuen-" + crypto.randomBytes(12).toString("base64url");
    const secret = metodo === "none" ? null : tokenAleatorio("phs_");
    const nombre = String(body.client_name || "").slice(0, 120);
    await pool.query("INSERT INTO oauth_clientes (client_id, client_secret_hash, nombre, redirect_uris) VALUES ($1,$2,$3,$4)",
      [clientId, secret ? sha256(secret) : null, nombre, JSON.stringify(uris)]);
    const resp = {
      client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: nombre, redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: metodo,
    };
    if (secret) { resp.client_secret = secret; resp.client_secret_expires_at = 0; }
    return [201, resp];
  }
  async function cliente(clientId) {
    if (!clientId) return null;
    const { rows } = await pool.query("SELECT * FROM oauth_clientes WHERE client_id = $1", [String(clientId)]);
    return rows[0] || null;
  }
  function autenticarCliente(c, req, body) {
    if (!c) return false;
    if (!c.client_secret_hash) return true; // cliente público: lo protege PKCE
    let secret = body.client_secret;
    const h = req.headers.authorization || "";
    if (!secret && /^Basic /i.test(h)) {
      const [id, s] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
      if (decodeURIComponent(id || "") === c.client_id) secret = decodeURIComponent(s || "");
    }
    if (!secret) return false;
    const a = Buffer.from(sha256(secret)), b = Buffer.from(c.client_secret_hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ---------- autorización ----------
  // Valida los parámetros de /oauth/authorize. Si el cliente o la URL de
  // retorno no son válidos NO se redirige (se muestra error), como exige OAuth.
  async function validarSolicitud(req, q) {
    const c = await cliente(q.client_id);
    if (!c) return { fatal: "La aplicación que intenta conectarse no está registrada." };
    if (!q.redirect_uri || !c.redirect_uris.includes(q.redirect_uri)) return { fatal: "La URL de retorno no corresponde a la aplicación registrada." };
    const redirigirError = (error, desc) => ({ redirect: conParams(q.redirect_uri, { error, error_description: desc, state: q.state, iss: baseUrl(req) }) });
    if (q.response_type !== "code") return redirigirError("unsupported_response_type", "Solo se admite response_type=code.");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return redirigirError("invalid_request", "PKCE con S256 es obligatorio.");
    if (!recursoCoincide(req, q.resource)) return redirigirError("invalid_target", "El recurso solicitado no corresponde a este servidor.");
    const pedidos = String(q.scope || ALCANCES.join(" ")).split(/\s+/).filter(Boolean);
    const desconocidos = pedidos.filter((s) => !ALCANCES.includes(s));
    if (desconocidos.length) return redirigirError("invalid_scope", `Alcance desconocido: ${desconocidos.join(", ")}`);
    return { cliente: c, pideEscritura: pedidos.includes("escritura") };
  }
  function paramsSolicitud(q) {
    const out = {};
    for (const k of ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"]) if (q[k] !== undefined) out[k] = q[k];
    return out;
  }

  // Ticket firmado para el paso "elige la empresa": evita reenviar la clave.
  function firmarTicket(datos) {
    const p = Buffer.from(JSON.stringify(Object.assign({}, datos, { exp: Date.now() + 5 * 60 * 1000 }))).toString("base64url");
    return p + "." + crypto.createHmac("sha256", secreto).update("ticket." + p).digest("base64url");
  }
  function leerTicket(t) {
    const [p, s] = String(t || "").split(".");
    if (!p || !s) return null;
    const esperado = crypto.createHmac("sha256", secreto).update("ticket." + p).digest("base64url");
    if (s.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(esperado))) return null;
    const d = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    return d.exp > Date.now() ? d : null;
  }

  async function manejarAuthorize(req, res, q, metodo) {
    const v = await validarSolicitud(req, q);
    if (v.fatal) return html(res, 400, paginas.paginaError(v.fatal));
    if (v.redirect) return redirigir(res, v.redirect);
    const params = paramsSolicitud(q);
    const clienteNombre = v.cliente.nombre || "Claude";
    if (metodo === "GET") return html(res, 200, paginas.paginaLogin({ params, clienteNombre, pideEscritura: v.pideEscritura }));

    // POST
    if (q.accion === "denegar") return redirigir(res, conParams(q.redirect_uri, { error: "access_denied", error_description: "El usuario canceló la autorización.", state: q.state, iss: baseUrl(req) }));
    const escritura = v.pideEscritura && q.permitir_escritura === "si";
    let elegido = null;
    if (q.paso === "empresa") {
      const t = leerTicket(q.ticket);
      if (!t || t.clientId !== q.client_id) return html(res, 400, paginas.paginaLogin({ params, clienteNombre, pideEscritura: v.pideEscritura, error: "La selección expiró. Vuelve a ingresar tu correo y clave." }));
      const op = t.opciones.find((o) => o.companyId === q.empresaId);
      if (!op) return html(res, 400, paginas.paginaError("Empresa no válida."));
      elegido = op;
    } else {
      const ip = ipDe(req);
      const email = String(q.email || "").trim().toLowerCase();
      if (bloqueado("ip:" + ip, MAX_FALLOS_IP, VENTANA_LOGIN_MS) || bloqueado("correo:" + email, MAX_FALLOS_CORREO, VENTANA_LOGIN_MS)) {
        return html(res, 429, paginas.paginaLogin({ params, clienteNombre, pideEscritura: v.pideEscritura, error: "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo." }));
      }
      const r = await validarCredenciales(email, q.clave || "");
      if (r.error) {
        anotarFallo("ip:" + ip, VENTANA_LOGIN_MS); anotarFallo("correo:" + email, VENTANA_LOGIN_MS);
        return html(res, 401, paginas.paginaLogin({ params, clienteNombre, pideEscritura: v.pideEscritura, email, error: r.error }));
      }
      if (r.opciones.length > 1) {
        const ticket = firmarTicket({ clientId: q.client_id, opciones: r.opciones });
        return html(res, 200, paginas.paginaElegirEmpresa({ params, empresas: r.opciones.map((o) => ({ id: o.companyId, nombre: o.empresaNombre })), ticket, escritura }));
      }
      elegido = r.opciones[0];
    }
    const codigo = tokenAleatorio("phc_");
    const scope = escritura ? "lectura escritura" : "lectura";
    await pool.query(
      `INSERT INTO oauth_codigos (codigo_hash, client_id, company_id, usuario_id, redirect_uri, code_challenge, scope, resource, expira_at, familia)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $9), $10)`,
      [sha256(codigo), q.client_id, elegido.companyId, elegido.usuarioId, q.redirect_uri, q.code_challenge, scope, q.resource || null, TTL_CODIGO_S, crypto.randomUUID()]
    );
    return redirigir(res, conParams(q.redirect_uri, { code: codigo, state: q.state, iss: baseUrl(req) }));
  }

  // Mismas reglas que POST /api/auth/login con {email, clave}.
  async function validarCredenciales(email, clave) {
    const MSG = "Correo o clave incorrectos.";
    if (!email || !clave) return { error: MSG };
    const candidatos = await dbFindUsuariosPorEmail(email);
    const ok = candidatos.filter((c) => c.data.activo !== false && verifyPassword(clave, c.data.claveHash));
    if (!ok.length) return { error: MSG };
    const opciones = [];
    let pendiente = false, noHabilitada = false;
    for (const c of ok) {
      const e = await dbGetEmpresa(c.companyId);
      if (!e || e.activo === false) continue;
      if (e.aprobada === false) { pendiente = true; continue; }
      if (!empresaHabilitada(e)) { noHabilitada = true; continue; }
      opciones.push({ companyId: c.companyId, usuarioId: c.data.id, empresaNombre: e.nombre });
    }
    if (!opciones.length) {
      // La clave ya se validó: informar el motivo real no expone datos ajenos.
      if (noHabilitada) return { error: "Tu empresa todavía no tiene habilitada la conexión con Claude. Pide al administrador de la plataforma que la habilite." };
      return { error: pendiente ? "Tu empresa todavía está pendiente de aprobación." : MSG };
    }
    return { opciones };
  }

  // ---------- token ----------
  async function manejarToken(req, body) {
    if (!permitir("token:" + ipDe(req), 60, 60 * 1000)) return [429, { error: "slow_down", error_description: "Demasiadas solicitudes." }];
    let clientId = body.client_id;
    const h = req.headers.authorization || "";
    if (!clientId && /^Basic /i.test(h)) clientId = decodeURIComponent(Buffer.from(h.slice(6), "base64").toString("utf8").split(":")[0] || "");
    const c = await cliente(clientId);
    if (!autenticarCliente(c, req, body)) return [401, { error: "invalid_client", error_description: "Cliente no válido." }];

    if (body.grant_type === "authorization_code") {
      const { rows } = await pool.query("SELECT * FROM oauth_codigos WHERE codigo_hash = $1", [sha256(body.code || "")]);
      const cod = rows[0];
      if (!cod || cod.client_id !== c.client_id) return [400, { error: "invalid_grant", error_description: "Código no válido." }];
      if (cod.usado_at) {
        // Reutilización de un código: se revoca todo lo emitido con él.
        await pool.query("UPDATE oauth_tokens SET revocado_at = now() WHERE familia = $1 AND revocado_at IS NULL", [cod.familia]);
        return [400, { error: "invalid_grant", error_description: "El código ya fue usado." }];
      }
      if (new Date(cod.expira_at) < new Date()) return [400, { error: "invalid_grant", error_description: "El código expiró." }];
      if (body.redirect_uri !== cod.redirect_uri) return [400, { error: "invalid_grant", error_description: "redirect_uri no coincide." }];
      const verif = String(body.code_verifier || "");
      if (verif.length < 43 || verif.length > 128 || crypto.createHash("sha256").update(verif).digest("base64url") !== cod.code_challenge) {
        return [400, { error: "invalid_grant", error_description: "PKCE: code_verifier no válido." }];
      }
      if (body.resource && !recursoCoincide(req, body.resource)) return [400, { error: "invalid_target" }];
      const marcado = await pool.query("UPDATE oauth_codigos SET usado_at = now() WHERE codigo_hash = $1 AND usado_at IS NULL", [cod.codigo_hash]);
      if (!marcado.rowCount) return [400, { error: "invalid_grant", error_description: "El código ya fue usado." }];
      if (!(await usuarioSigueHabilitado(cod.company_id, cod.usuario_id))) return [400, { error: "invalid_grant", error_description: "El usuario o la empresa ya no están habilitados." }];
      return [200, await emitir(c.client_id, cod.company_id, cod.usuario_id, cod.scope, cod.resource, cod.familia)];
    }

    if (body.grant_type === "refresh_token") {
      const { rows } = await pool.query("SELECT * FROM oauth_tokens WHERE token_hash = $1 AND tipo = 'renovacion'", [sha256(body.refresh_token || "")]);
      const t = rows[0];
      if (!t || t.client_id !== c.client_id) return [400, { error: "invalid_grant", error_description: "Token de renovación no válido." }];
      if (t.revocado_at) {
        // Reutilización de un token ya rotado: posible robo, se revoca toda la familia.
        await pool.query("UPDATE oauth_tokens SET revocado_at = now() WHERE familia = $1 AND revocado_at IS NULL", [t.familia]);
        return [400, { error: "invalid_grant", error_description: "Token de renovación ya usado." }];
      }
      if (new Date(t.expira_at) < new Date()) return [400, { error: "invalid_grant", error_description: "Token de renovación expirado." }];
      let scope = t.scope;
      if (body.scope) {
        const pedidos = String(body.scope).split(/\s+/).filter(Boolean);
        if (pedidos.some((s) => !t.scope.split(" ").includes(s))) return [400, { error: "invalid_scope" }];
        scope = pedidos.join(" ");
      }
      const rot = await pool.query("UPDATE oauth_tokens SET revocado_at = now() WHERE token_hash = $1 AND revocado_at IS NULL", [t.token_hash]);
      if (!rot.rowCount) return [400, { error: "invalid_grant", error_description: "Token de renovación ya usado." }];
      if (!(await usuarioSigueHabilitado(t.company_id, t.usuario_id))) {
        await pool.query("UPDATE oauth_tokens SET revocado_at = now() WHERE familia = $1 AND revocado_at IS NULL", [t.familia]);
        return [400, { error: "invalid_grant", error_description: "El usuario o la empresa ya no están habilitados." }];
      }
      return [200, await emitir(c.client_id, t.company_id, t.usuario_id, scope, t.resource, t.familia)];
    }
    return [400, { error: "unsupported_grant_type" }];
  }

  async function emitir(clientId, companyId, usuarioId, scope, resource, familia) {
    const acceso = tokenAleatorio("pha_"), renovacion = tokenAleatorio("phr_");
    await pool.query(
      `INSERT INTO oauth_tokens (token_hash, tipo, client_id, company_id, usuario_id, scope, resource, familia, expira_at) VALUES
       ($1,'acceso',$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $9)),
       ($2,'renovacion',$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $10))`,
      [sha256(acceso), sha256(renovacion), clientId, companyId, usuarioId, scope, resource, familia, TTL_ACCESO_S, TTL_RENOVACION_S]
    );
    return { access_token: acceso, token_type: "Bearer", expires_in: TTL_ACCESO_S, refresh_token: renovacion, scope };
  }

  async function usuarioSigueHabilitado(companyId, usuarioId) {
    const e = await dbGetEmpresa(companyId);
    if (!e || e.activo === false || e.aprobada === false || !empresaHabilitada(e)) return false;
    const { rows } = await pool.query("SELECT data FROM records WHERE company_id = $1 AND store = 'accesoUsuarios' AND id = $2", [companyId, usuarioId]);
    return !!(rows[0] && rows[0].data.activo !== false);
  }

  async function manejarRevocar(req, body) {
    let clientId = body.client_id;
    const h = req.headers.authorization || "";
    if (!clientId && /^Basic /i.test(h)) clientId = decodeURIComponent(Buffer.from(h.slice(6), "base64").toString("utf8").split(":")[0] || "");
    const c = await cliente(clientId);
    if (!autenticarCliente(c, req, body)) return [401, { error: "invalid_client" }];
    const { rows } = await pool.query("SELECT familia, client_id FROM oauth_tokens WHERE token_hash = $1", [sha256(body.token || "")]);
    if (rows[0] && rows[0].client_id === c.client_id) {
      await pool.query("UPDATE oauth_tokens SET revocado_at = now() WHERE familia = $1 AND revocado_at IS NULL", [rows[0].familia]);
    }
    return [200, {}]; // RFC 7009: siempre 200, exista o no el token
  }

  // Verifica un token de acceso de /mcp. Devuelve la fila o null.
  async function verificarAcceso(req, token) {
    if (!token) return null;
    const { rows } = await pool.query(
      "SELECT * FROM oauth_tokens WHERE token_hash = $1 AND tipo = 'acceso' AND revocado_at IS NULL AND expira_at > now()",
      [sha256(token)]
    );
    const t = rows[0];
    if (!t) return null;
    if (t.resource && !recursoCoincide(req, t.resource)) return null;
    return t;
  }

  return {
    ALCANCES, baseUrl, recursoUrl, metadatosRecurso, metadatosServidor, registrar,
    manejarAuthorize, manejarToken, manejarRevocar, verificarAcceso, usuarioSigueHabilitado,
  };
}

function conParams(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  return u.toString();
}
function enviarHtml(res, status, cuerpo, origenesRetorno) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${origenesRetorno}; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
  });
  res.end(cuerpo);
}
function redirigir(res, url) {
  res.writeHead(302, { Location: url, "Cache-Control": "no-store" });
  res.end();
}

module.exports = { crearOAuth, ALCANCES };
