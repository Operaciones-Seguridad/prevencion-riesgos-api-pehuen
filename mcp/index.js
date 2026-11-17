"use strict";
// Conector MCP para claude.ai: rutas /mcp, /oauth/* y /.well-known/*.
// server.js lo llama ANTES de sus propias rutas; si la URL no es del
// conector, devuelve false y la app sigue exactamente igual que antes.

const { crearOAuth } = require("./oauth");
const { crearProtocolo, rpcErr } = require("./protocolo");
const { construirContexto } = require("./contexto");
const { crearDatos } = require("./datos");

// 14 MB: alcanza para el máximo de fotos por llamada de la investigación de
// tránsito (6 × 1,5 MB, que en base64 ocupan ~2 MB cada una).
const MAX_CUERPO = 14 * 1024 * 1024;

function crearConector(deps) {
  const { pool, dbGetEmpresa } = deps;
  const datos = crearDatos(pool);
  const oauth = crearOAuth(deps);
  const herramientas = [
    ...require("./herramientas/general")(datos, pool),
    ...require("./herramientas/trabajadores")(datos),
    ...require("./herramientas/miper")(datos),
    ...require("./herramientas/programa")(datos),
    ...require("./herramientas/capacitacion")(datos),
    ...require("./herramientas/documentos")(datos),
    ...require("./herramientas/accidentabilidad")(datos),
  ];
  const nombres = new Set();
  for (const h of herramientas) { if (nombres.has(h.name)) throw new Error("herramienta duplicada " + h.name); nombres.add(h.name); }
  const protocolo = crearProtocolo(herramientas);
  const origenesPermitidos = (process.env.MCP_ORIGENES_PERMITIDOS || "https://claude.ai,https://claude.com").split(",").map((s) => s.trim()).filter(Boolean);

  async function manejar(req, res, url) {
    const ruta = url.pathname.replace(/\/+$/, "") || "/";
    try {
      // --- descubrimiento ---
      if (req.method === "GET" && (ruta === "/.well-known/oauth-protected-resource" || ruta === "/.well-known/oauth-protected-resource/mcp")) return json(res, 200, oauth.metadatosRecurso(req)), true;
      if (req.method === "GET" && (ruta === "/.well-known/oauth-authorization-server" || ruta === "/.well-known/oauth-authorization-server/mcp")) return json(res, 200, oauth.metadatosServidor(req)), true;

      // --- OAuth ---
      if (ruta === "/oauth/register" && req.method === "POST") {
        const [st, body] = await oauth.registrar((await leerCuerpo(req)).datos || {});
        return json(res, st, body), true;
      }
      if (ruta === "/oauth/authorize" && (req.method === "GET" || req.method === "POST")) {
        const q = req.method === "GET" ? Object.fromEntries(url.searchParams) : (await leerCuerpo(req)).datos || {};
        await oauth.manejarAuthorize(req, res, q, req.method);
        return true;
      }
      if (ruta === "/oauth/token" && req.method === "POST") {
        const [st, body] = await oauth.manejarToken(req, (await leerCuerpo(req)).datos || {});
        return json(res, st, body, { "Cache-Control": "no-store", Pragma: "no-cache" }), true;
      }
      if (ruta === "/oauth/revoke" && req.method === "POST") {
        const [st, body] = await oauth.manejarRevocar(req, (await leerCuerpo(req)).datos || {});
        return json(res, st, body), true;
      }

      // --- MCP ---
      if (ruta === "/mcp") {
        const origen = req.headers.origin;
        if (origen && !origenesPermitidos.includes(origen)) return json(res, 403, rpcErr(null, -32000, "Origen no permitido.")), true;
        if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return true; }
        const token = (/^Bearer\s+(.+)$/i.exec(req.headers.authorization || "") || [])[1];
        const t = await oauth.verificarAcceso(req, token);
        const ctx = t ? await construirContexto(pool, dbGetEmpresa, t) : null;
        if (!ctx) {
          res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${oauth.baseUrl(req)}/.well-known/oauth-protected-resource"${token ? ', error="invalid_token"' : ""}`);
          return json(res, 401, rpcErr(null, -32001, "Autenticación requerida.")), true;
        }
        const c = await leerCuerpo(req);
        if (c.error) return json(res, 400, rpcErr(null, -32700, c.error)), true;
        const [st, body] = await protocolo.procesar(ctx, c.datos);
        if (body === null) { res.writeHead(st); res.end(); return true; }
        return json(res, st, body), true;
      }
      return false;
    } catch (err) {
      console.error("[mcp]", err);
      json(res, 500, { error: "server_error", error_description: "Error interno del servidor." });
      return true;
    }
  }
  return { manejar, herramientas, protocolo, datos, oauth };
}

function json(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) }, extra || {}));
  res.end(body);
}
// Lee JSON o application/x-www-form-urlencoded.
function leerCuerpo(req) {
  return new Promise((resolve) => {
    let data = "", size = 0, cortado = false;
    req.on("data", (ch) => { size += ch.length; if (size > MAX_CUERPO) { cortado = true; req.destroy(); resolve({ error: "Cuerpo demasiado grande." }); return; } data += ch; });
    req.on("end", () => {
      if (cortado) return;
      if (!data) return resolve({ datos: undefined });
      const tipo = String(req.headers["content-type"] || "");
      if (tipo.includes("application/x-www-form-urlencoded")) return resolve({ datos: Object.fromEntries(new URLSearchParams(data)) });
      try { resolve({ datos: JSON.parse(data) }); } catch (e) { resolve({ error: "JSON inválido." }); }
    });
    req.on("error", () => resolve({ error: "Error al leer la solicitud." }));
  });
}

module.exports = { crearConector };
