/*
 * Backend real para la app "Sistema de Gestión Prevención de Riesgos"
 * (Pehuén). Reemplaza el almacenamiento local (IndexedDB) por una
 * base de datos PostgreSQL compartida, con autenticación real (clave
 * con hash + token de sesión firmado).
 *
 * Diseño deliberadamente simple: usa solo el módulo nativo `http` de
 * Node (sin Express) y `crypto` nativo (sin bcrypt/jsonwebtoken), para
 * minimizar dependencias externas. La única dependencia real es "pg"
 * (cliente de PostgreSQL), que Render instala automáticamente durante
 * el despliegue (`npm install`).
 *
 * Modelo de datos: una única tabla `records(store, id, data JSONB)`
 * que refleja exactamente los "stores" que la app ya usaba en
 * IndexedDB — así el resto del código de la app (que siempre llama a
 * getAll(store)/put(store,obj)/deleteRecord(store,id)/clearStore(store))
 * no necesita rediseñarse, solo apuntar a esta API en vez de IndexedDB.
 */
"use strict";

const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*"; // dominio del sitio estático (Netlify/Vercel/etc.), o "*" para pruebas
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 días

if (!JWT_SECRET) {
  console.error("Falta la variable de entorno JWT_SECRET. Defínela antes de iniciar el servidor.");
  process.exit(1);
}

// Mismo listado exacto de "stores" que usa app.html (constante STORES).
// Cualquier nombre de store que no esté en esta lista se rechaza, para
// evitar que la API se use como una base de datos genérica arbitraria.
const STORES = [
  "empresa", "areas", "trabajadores", "protocolos", "inspecciones", "matriz",
  "examenes", "checklists", "programa", "capacitaciones", "accidentes",
  "horasHombre", "matrizHistorial", "catalogosExtra", "epp", "planoRiesgos",
  "estudioEpp", "medidasControlVS", "cumplimientoLegal", "bitacoraProtocolo",
  "ganttProtocolo", "infractores", "rankingVelocidad", "astRegistros",
  "tmertRegistros", "arbolesCausales", "riohys", "documentos",
  "cphysMiembros", "cphysReuniones", "correosResponsables", "cphysPrograma",
  "cphysCapacitaciones", "grdAmenazas", "grdComite", "grdPlanRespuesta",
  "grdSimulacros", "grdPlanAccion", "iapRegistros", "accesoPerfiles",
  "accesoUsuarios", "levantamientos", "compromisosItems", "compromisosRegistros",
];
const STORES_SET = new Set(STORES);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : (process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false),
});

// ---------- utilidades de contraseña (scrypt, nativo de Node) ----------
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plain, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}
function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== "string" || !stored.startsWith("scrypt:")) return false;
  const [, salt, hash] = stored.split(":");
  try {
    const hashBuf = Buffer.from(hash, "hex");
    const testBuf = crypto.scryptSync(plain, salt, 64);
    return hashBuf.length === testBuf.length && crypto.timingSafeEqual(hashBuf, testBuf);
  } catch (e) {
    return false;
  }
}

// ---------- token de sesión firmado (equivalente minimo a un JWT HS256) ----------
function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function signToken(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({}, payload, { iat: now, exp: now + TOKEN_TTL_SECONDS });
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(body)));
  const sig = b64url(crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = b64url(crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest());
  if (sig !== expected) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch (e) {
    return null;
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

// ---------- helpers HTTP ----------
function setCors(req, res) {
  const origin = req.headers.origin;
  if (CORS_ORIGIN === "*") {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else {
    const allowed = CORS_ORIGIN.split(",").map((s) => s.trim());
    if (origin && allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    const MAX = 25 * 1024 * 1024; // 25MB (adjuntos en base64 pueden pesar)
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX) { reject(new Error("Cuerpo de la solicitud demasiado grande.")); req.destroy(); return; }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("JSON inválido en el cuerpo de la solicitud.")); }
    });
    req.on("error", reject);
  });
}
function getBearerToken(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

// Quita el hash de clave de un registro de accesoUsuarios antes de
// devolverlo al cliente: la contraseña (ni siquiera su hash) debe
// viajar nunca hacia el navegador.
function sanitizeUsuario(data) {
  if (!data || typeof data !== "object") return data;
  const copy = Object.assign({}, data);
  delete copy.claveHash;
  delete copy.clave;
  return copy;
}

// ---------- acceso a datos ----------
async function dbGetAll(store) {
  const { rows } = await pool.query("SELECT data FROM records WHERE store = $1 ORDER BY updated_at ASC", [store]);
  const out = rows.map((r) => r.data);
  return store === "accesoUsuarios" ? out.map(sanitizeUsuario) : out;
}
async function dbGetOne(store, id) {
  const { rows } = await pool.query("SELECT data FROM records WHERE store = $1 AND id = $2", [store, id]);
  return rows[0] ? rows[0].data : null;
}
async function dbUpsert(store, obj) {
  await pool.query(
    `INSERT INTO records (store, id, data, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (store, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [store, obj.id, obj]
  );
}
async function dbDeleteOne(store, id) {
  await pool.query("DELETE FROM records WHERE store = $1 AND id = $2", [store, id]);
}
async function dbClearStore(store) {
  await pool.query("DELETE FROM records WHERE store = $1", [store]);
}

// ---------- redacción automática de documentos con IA (v1.74) ----------
// Usa la API de mensajes de Anthropic (Claude) para redactar un borrador de
// política, procedimiento o manual, dando como contexto los datos reales ya
// cargados en esta misma empresa (rubro, áreas). Requiere que la variable de
// entorno ANTHROPIC_API_KEY esté configurada; si no lo está, se informa un
// error claro en vez de fallar de forma confusa. Usa fetch nativo de Node
// (disponible desde Node 18+), sin agregar ninguna dependencia nueva.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = "claude-sonnet-5";

const TIPO_DOC_LABEL_IA = { politica: "una Política de Seguridad y Salud en el Trabajo (SST)", procedimiento: "un Procedimiento o Instructivo de trabajo seguro", manual: "un Manual del sistema de gestión de prevención de riesgos" };

async function redactarDocumentoConIA({ tipo, nombre, contextoAdicional }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("La redacción con IA no está configurada en este servidor: falta la variable de entorno ANTHROPIC_API_KEY.");
    err.statusCode = 500;
    throw err;
  }
  const empresa = await dbGetAll("empresa");
  const areas = await dbGetAll("areas");
  const razonSocial = (empresa[0] && empresa[0].razonSocial) || "la empresa";
  const rubro = (empresa[0] && empresa[0].rubro) || "no especificado";
  const nombresAreas = areas.map((a) => a.nombre).filter(Boolean).join(", ") || "no especificadas";
  const tipoDescripcion = TIPO_DOC_LABEL_IA[tipo] || "un documento del sistema de gestión de prevención de riesgos";

  const prompt = `Eres un prevencionista de riesgos experto en normativa chilena (Ley N°16.744, DS N°44/2024, DS N°594). Redacta el contenido completo de ${tipoDescripcion} para la siguiente empresa:

- Razón social: ${razonSocial}
- Rubro: ${rubro}
- Áreas de la empresa: ${nombresAreas}
${contextoAdicional ? `- Contexto adicional indicado por el usuario: ${contextoAdicional}` : ""}
- Nombre del documento a redactar: "${nombre}"

Redacta el contenido en español de Chile, en formato de texto plano con títulos numerados (1. Objetivo, 2. Alcance, 3. ...), listo para pegar directamente en el campo "Contenido" del documento. No agregues portada, tabla de control de versiones ni hoja de firmas (eso ya lo genera la app por separado). Sé concreto y aterrizado al rubro y áreas indicadas, no genérico.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch (e) {}
    const err = new Error(detail || `El servicio de IA respondió con un error (${res.status}).`);
    err.statusCode = 502;
    throw err;
  }
  const data = await res.json();
  const texto = (data.content || []).map((b) => b.text || "").join("\n").trim();
  if (!texto) {
    const err = new Error("El servicio de IA no devolvió contenido.");
    err.statusCode = 502;
    throw err;
  }
  return texto;
}

// ---------- arranque: garantiza que exista al menos un admin ----------
// Reproduce exactamente seedAccesosPorDefecto()/seedCompromisosPorDefecto()
// de app.html, pero corriendo en el servidor al iniciar (no vía la API),
// para que un usuario nunca quede sin forma de entrar la primera vez.
async function seedIfEmpty() {
  const usuarios = await dbGetAll("accesoUsuarios");
  if (usuarios.length === 0) {
    const perfilAdminId = crypto.randomUUID();
    const perfilPrevId = crypto.randomUUID();
    const perfilSupervisorId = crypto.randomUUID();
    const perfilTrabajadorId = crypto.randomUUID();
    const TODAS_LAS_VISTAS = ["dashboard", "realizar-inspecciones", "inspecciones", "matriz", "vigilancia", "programa", "capacitacion", "accidentabilidad", "seguridad", "epp", "cumplimiento", "riohys", "documentos", "cphys", "emergencia", "compromisos", "config"];
    await dbUpsert("accesoPerfiles", { id: perfilAdminId, nombre: "Administrador", esAdmin: true, vistas: TODAS_LAS_VISTAS.slice() });
    await dbUpsert("accesoPerfiles", { id: perfilPrevId, nombre: "Prevencionista de Riesgos", esAdmin: false, vistas: TODAS_LAS_VISTAS.filter((v) => v !== "config") });
    await dbUpsert("accesoPerfiles", { id: perfilSupervisorId, nombre: "Jefe de Obra / Supervisor", esAdmin: false, vistas: ["dashboard", "realizar-inspecciones", "inspecciones", "matriz", "programa", "capacitacion", "accidentabilidad", "emergencia", "compromisos"] });
    await dbUpsert("accesoPerfiles", { id: perfilTrabajadorId, nombre: "Trabajador", esAdmin: false, descargaDashboard: false, vistas: ["dashboard", "realizar-inspecciones"] });
    await dbUpsert("accesoUsuarios", { id: crypto.randomUUID(), nombre: "Administrador del sistema", cargo: "Administrador", perfilId: perfilAdminId, claveHash: hashPassword("admin123"), activo: true });
    console.log('Sembrado usuario "Administrador del sistema" con clave inicial admin123 (cámbiala luego de tu primer ingreso).');
  }
  const compromisos = await dbGetAll("compromisosItems");
  if (compromisos.length === 0) {
    const ITEMS_DEFECTO = [
      "Estadística Mensual", "Reporte de Gestión",
      "Reunión del Comité Paritario de Higiene y Seguridad",
      "Reunión del Comité de Emergencias y Desastres",
      "Reunión del Comité de Seguridad Vial",
      "Reunión del Comité de Aplicación PEC Competitivo",
      "Reunión del Comité de Aplicación TMERT–MMC",
      "Reunión del Comité de Seguridad Zonal Malleco",
      "Reunión Mensual de Prevencionistas Malleco",
      "Reunión Mensual de Operaciones Frontel",
      "Noticiero de Seguridad", "Jornada de Seguridad – Obras",
      "Jornada de Seguridad – Operaciones", "RMCAP",
    ];
    for (const nombre of ITEMS_DEFECTO) {
      await dbUpsert("compromisosItems", { id: crypto.randomUUID(), nombre, metaMensual: 1, mesesRevision: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
    }
  }
}

// ---------- servidor HTTP ----------
const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "matriz", ...]

  try {
    if (url.pathname === "/health") { sendJson(res, 200, { ok: true }); return; }

    if (parts[0] !== "api") { sendJson(res, 404, { error: "No encontrado." }); return; }

    // --- Endpoints públicos (sin autenticación) ---
    if (req.method === "GET" && parts[1] === "public" && parts[2] === "usuarios") {
      const usuarios = await dbGetAll("accesoUsuarios");
      sendJson(res, 200, usuarios.map((u) => ({ id: u.id, nombre: u.nombre, cargo: u.cargo, activo: u.activo })));
      return;
    }
    if (req.method === "POST" && parts[1] === "auth" && parts[2] === "login") {
      const body = (await readBody(req)) || {};
      const usuario = await dbGetOne("accesoUsuarios", body.usuarioId);
      if (!usuario || usuario.activo === false || !verifyPassword(body.clave || "", usuario.claveHash)) {
        sendJson(res, 401, { error: "Usuario o clave incorrectos." });
        return;
      }
      const token = signToken({ sub: usuario.id });
      sendJson(res, 200, { token, usuario: sanitizeUsuario(usuario) });
      return;
    }

    // --- A partir de aquí, todo requiere sesión válida ---
    const payload = verifyToken(getBearerToken(req));
    if (!payload) { sendJson(res, 401, { error: "Sesión inválida o expirada. Vuelve a iniciar sesión." }); return; }

    if (req.method === "POST" && parts[1] === "ia" && parts[2] === "redactar-documento") {
      const body = (await readBody(req)) || {};
      if (!body.tipo || !body.nombre) { sendJson(res, 400, { error: "Debes indicar el tipo y el nombre del documento." }); return; }
      try {
        const contenido = await redactarDocumentoConIA(body);
        sendJson(res, 200, { contenido });
      } catch (err) {
        sendJson(res, err.statusCode || 500, { error: err.message });
      }
      return;
    }

    const store = parts[1];
    if (!STORES_SET.has(store)) { sendJson(res, 404, { error: `Store desconocido: ${store}` }); return; }

    if (req.method === "GET" && parts.length === 2) {
      const rows = await dbGetAll(store);
      sendJson(res, 200, rows);
      return;
    }

    if (req.method === "POST" && parts.length === 2) {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || !body.id) { sendJson(res, 400, { error: "El registro debe incluir un id." }); return; }
      let toStore = body;
      if (store === "accesoUsuarios") {
        const existing = await dbGetOne(store, body.id);
        toStore = Object.assign({}, body);
        delete toStore.clave;
        if (body.clave) {
          toStore.claveHash = hashPassword(body.clave);
        } else if (existing && existing.claveHash) {
          toStore.claveHash = existing.claveHash;
        } else {
          sendJson(res, 400, { error: "Debes indicar una clave para un usuario nuevo." });
          return;
        }
      }
      await dbUpsert(store, toStore);
      sendJson(res, 200, store === "accesoUsuarios" ? sanitizeUsuario(toStore) : toStore);
      return;
    }

    if (req.method === "DELETE" && parts.length === 3) {
      await dbDeleteOne(store, decodeURIComponent(parts[2]));
      res.writeHead(204); res.end();
      return;
    }

    if (req.method === "DELETE" && parts.length === 2) {
      await dbClearStore(store);
      res.writeHead(204); res.end();
      return;
    }

    sendJson(res, 404, { error: "Ruta no encontrada." });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: "Error interno del servidor.", detail: String((err && err.message) || err) });
  }
});

async function main() {
  await pool.query(require("fs").readFileSync(require("path").join(__dirname, "schema.sql"), "utf8"));
  await seedIfEmpty();
  server.listen(PORT, () => console.log(`API de Prevención de Riesgos escuchando en el puerto ${PORT}`));
}
main().catch((err) => { console.error("No se pudo iniciar el servidor:", err); process.exit(1); });
