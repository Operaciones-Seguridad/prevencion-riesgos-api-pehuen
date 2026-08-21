/*
 * Backend real para la app "Sistema de Gestión Prevención de Riesgos"
 * — versión MULTI-EMPRESA: una sola instalación (un solo servidor, una
 * sola base de datos) puede atender a varias empresas/clientes a la vez,
 * cada una con sus propios datos, usuarios y clave de acceso, sin que se
 * mezclen entre sí.
 *
 * Diseño: exactamente el mismo que la versión de una sola empresa (usa
 * solo los módulos nativos `http`/`crypto` de Node, más `pg` para
 * PostgreSQL), pero cada fila de la tabla `records` ahora lleva además
 * un `company_id`, y toda operación autenticada queda automáticamente
 * limitada a la empresa del usuario que inició sesión (el company_id
 * viaja dentro del token de sesión firmado, nunca se confía en un valor
 * que mande el navegador).
 *
 * Cómo se agregan empresas nuevas: un administrador ya autenticado en
 * cualquier empresa puede crear una empresa nueva desde Configuración
 * ("+ Nueva empresa"). Al crearla, el servidor siembra automáticamente
 * su primer usuario ("Administrador del sistema" / clave admin123), sus
 * perfiles de acceso por defecto y su catálogo de protocolos de
 * vigilancia de salud — exactamente lo mismo que antes se hacía a mano
 * desplegando un servidor y una base de datos nuevos en Render.
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

// Mismo listado exacto de "stores" que usa la app (constante STORES),
// incluido "empresa" (la ficha/perfil de la propia compañía: razón
// social, rut, rubro, etc.), que ahora es un store más scopeado por
// company_id igual que todos los demás -- cada empresa tiene su propia
// fila "empresa", sin necesidad de tratarla como caso especial.
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
// A partir de la versión multi-empresa, el payload incluye companyId
// además de sub (id de usuario): es el propio token -- firmado con
// JWT_SECRET, imposible de falsificar sin conocer el secreto -- el que
// determina a qué empresa pertenecen todas las operaciones siguientes.
// Nunca se confía en un company_id que venga suelto en el cuerpo o la
// URL de una solicitud autenticada.
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
  if (!payload.companyId) return null; // token de una versión anterior, sin empresa: inválido
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
// Convierte un nombre de empresa en un id legible y único (slug), con un
// sufijo aleatorio corto para evitar choques entre nombres parecidos.
function slugify(nombre) {
  const base = String(nombre || "empresa")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "empresa";
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

// ---------- acceso a datos: EMPRESAS (registro maestro de compañías) ----------
async function dbListEmpresas() {
  const { rows } = await pool.query("SELECT id, nombre, activo FROM empresas WHERE activo = true ORDER BY nombre ASC");
  return rows;
}
async function dbGetEmpresa(id) {
  const { rows } = await pool.query("SELECT id, nombre, activo FROM empresas WHERE id = $1", [id]);
  return rows[0] || null;
}
async function dbCreateEmpresa(nombre) {
  const id = slugify(nombre);
  await pool.query("INSERT INTO empresas (id, nombre) VALUES ($1, $2)", [id, nombre]);
  return { id, nombre, activo: true };
}
// Elimina una empresa por completo. Como records.company_id tiene una
// llave foránea "ON DELETE CASCADE" hacia empresas(id), esto borra en
// cascada absolutamente todos los datos de esa empresa (trabajadores,
// accidentes, EPP, usuarios, documentos, todo) -- es irreversible.
async function dbDeleteEmpresa(id) {
  await pool.query("DELETE FROM empresas WHERE id = $1", [id]);
}

// ---------- acceso a datos: STORES (scopeados por company_id) ----------
async function dbGetAll(companyId, store) {
  const { rows } = await pool.query(
    "SELECT data FROM records WHERE company_id = $1 AND store = $2 ORDER BY updated_at ASC",
    [companyId, store]
  );
  const out = rows.map((r) => r.data);
  return store === "accesoUsuarios" ? out.map(sanitizeUsuario) : out;
}
async function dbGetOne(companyId, store, id) {
  const { rows } = await pool.query(
    "SELECT data FROM records WHERE company_id = $1 AND store = $2 AND id = $3",
    [companyId, store, id]
  );
  return rows[0] ? rows[0].data : null;
}
async function dbUpsert(companyId, store, obj) {
  await pool.query(
    `INSERT INTO records (company_id, store, id, data, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (company_id, store, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [companyId, store, obj.id, obj]
  );
}
async function dbDeleteOne(companyId, store, id) {
  await pool.query("DELETE FROM records WHERE company_id = $1 AND store = $2 AND id = $3", [companyId, store, id]);
}
async function dbClearStore(companyId, store) {
  await pool.query("DELETE FROM records WHERE company_id = $1 AND store = $2", [companyId, store]);
}

// ---------- redacción automática de documentos con IA ----------
// Usa la API de mensajes de Anthropic (Claude) para redactar un borrador de
// política, procedimiento o manual, dando como contexto los datos reales ya
// cargados en la empresa activa (rubro, áreas). Requiere que la variable de
// entorno ANTHROPIC_API_KEY esté configurada; si no lo está, se informa un
// error claro en vez de fallar de forma confusa. Usa fetch nativo de Node
// (disponible desde Node 18+), sin agregar ninguna dependencia nueva.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = "claude-sonnet-5";

const TIPO_DOC_LABEL_IA = { politica: "una Política de Seguridad y Salud en el Trabajo (SST)", procedimiento: "un Procedimiento o Instructivo de trabajo seguro", manual: "un Manual del sistema de gestión de prevención de riesgos" };

async function redactarDocumentoConIA(companyId, { tipo, nombre, contextoAdicional }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("La redacción con IA no está configurada en este servidor: falta la variable de entorno ANTHROPIC_API_KEY.");
    err.statusCode = 500;
    throw err;
  }
  const empresa = await dbGetAll(companyId, "empresa");
  const areas = await dbGetAll(companyId, "areas");
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

// ---------- siembra de datos por defecto de una empresa nueva ----------
// Reproduce lo que antes había que hacer a mano (desplegar un servidor y una
// base de datos nuevos en Render): crea los perfiles de acceso estándar, el
// primer usuario administrador, el catálogo de protocolos de vigilancia de
// salud y el checklist de compromisos, todo ya asociado al company_id de la
// empresa recién creada. Devuelve el nombre del usuario/clave inicial para
// mostrárselo una sola vez a quien la creó.
async function sembrarEmpresaNueva(companyId, { rut, rubro } = {}) {
  const perfilAdminId = crypto.randomUUID();
  const perfilPrevId = crypto.randomUUID();
  const perfilSupervisorId = crypto.randomUUID();
  const perfilTrabajadorId = crypto.randomUUID();
  const TODAS_LAS_VISTAS = ["dashboard", "realizar-inspecciones", "inspecciones", "matriz", "vigilancia", "programa", "capacitacion", "accidentabilidad", "seguridad", "epp", "cumplimiento", "riohys", "documentos", "cphys", "emergencia", "compromisos", "config"];
  await dbUpsert(companyId, "accesoPerfiles", { id: perfilAdminId, nombre: "Administrador", esAdmin: true, vistas: TODAS_LAS_VISTAS.slice() });
  await dbUpsert(companyId, "accesoPerfiles", { id: perfilPrevId, nombre: "Prevencionista de Riesgos", esAdmin: false, vistas: TODAS_LAS_VISTAS.filter((v) => v !== "config") });
  await dbUpsert(companyId, "accesoPerfiles", { id: perfilSupervisorId, nombre: "Jefe de Obra / Supervisor", esAdmin: false, vistas: ["dashboard", "realizar-inspecciones", "inspecciones", "matriz", "programa", "capacitacion", "accidentabilidad", "emergencia", "compromisos"] });
  await dbUpsert(companyId, "accesoPerfiles", { id: perfilTrabajadorId, nombre: "Trabajador", esAdmin: false, descargaDashboard: false, vistas: ["dashboard", "realizar-inspecciones"] });
  await dbUpsert(companyId, "accesoUsuarios", { id: crypto.randomUUID(), nombre: "Administrador del sistema", cargo: "Administrador", perfilId: perfilAdminId, claveHash: hashPassword("admin123"), activo: true });

  const PROTOCOLOS_DEFECTO = [
    { id: "prexor", nombre: "PREXOR", agente: "Ruido (exposición ocupacional)", periodicidadMeses: 12 },
    { id: "planesi", nombre: "PLANESI", agente: "Sílice", periodicidadMeses: 12 },
    { id: "tmert", nombre: "TMERT", agente: "Trastornos musculoesqueléticos por trabajo repetitivo", periodicidadMeses: 12 },
    { id: "psicosocial", nombre: "Riesgos psicosociales", agente: "Factores psicosociales (SUSESO-ISTAS21)", periodicidadMeses: 24 },
    { id: "uv", nombre: "Radiación UV", agente: "Radiación solar (trabajo en exteriores)", periodicidadMeses: 12 },
    { id: "hipobaria", nombre: "Hipobaria / hiperbaria", agente: "Altitud geográfica o condiciones hiperbáricas", periodicidadMeses: 12 },
  ];
  for (const p of PROTOCOLOS_DEFECTO) await dbUpsert(companyId, "protocolos", p);

  const ITEMS_DEFECTO = [
    "Estadística Mensual", "Reporte de Gestión",
    "Reunión del Comité Paritario de Higiene y Seguridad",
    "Reunión del Comité de Emergencias y Desastres",
  ];
  for (const nombre of ITEMS_DEFECTO) {
    await dbUpsert(companyId, "compromisosItems", { id: crypto.randomUUID(), nombre, metaMensual: 1, mesesRevision: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
  }

  const empresaRow = await dbGetEmpresa(companyId);
  await dbUpsert(companyId, "empresa", { id: "empresa-1", razonSocial: (empresaRow && empresaRow.nombre) || "", rut: rut || "Por definir", rubro: rubro || "" });
}

// ---------- arranque: garantiza que exista al menos una empresa y un admin ----------
// Solo actúa como salvavidas ante una base de datos totalmente vacía (una
// instalación nueva desde cero); en la práctica, las empresas reales de
// esta instalación se crean una vez y luego se migran sus datos, así que
// esto casi nunca se ejecuta.
async function seedIfEmpty() {
  const empresas = await dbListEmpresas();
  if (empresas.length === 0) {
    const empresa = await dbCreateEmpresa("Empresa demo");
    await sembrarEmpresaNueva(empresa.id, {});
    console.log(`Sembrada empresa inicial "${empresa.nombre}" (id: ${empresa.id}) con usuario "Administrador del sistema" y clave inicial admin123 (cámbiala luego de tu primer ingreso).`);
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

    // --- Endpoints públicos (sin autenticación): elegir empresa y ver sus usuarios ---
    if (req.method === "GET" && parts[1] === "public" && parts[2] === "empresas") {
      const empresas = await dbListEmpresas();
      sendJson(res, 200, empresas);
      return;
    }
    if (req.method === "GET" && parts[1] === "public" && parts[2] === "usuarios") {
      const companyId = url.searchParams.get("empresaId") || "";
      const empresa = companyId ? await dbGetEmpresa(companyId) : null;
      if (!empresa || empresa.activo === false) { sendJson(res, 404, { error: "Empresa no encontrada." }); return; }
      const usuarios = await dbGetAll(companyId, "accesoUsuarios");
      sendJson(res, 200, usuarios.map((u) => ({ id: u.id, nombre: u.nombre, cargo: u.cargo, activo: u.activo })));
      return;
    }
    if (req.method === "POST" && parts[1] === "auth" && parts[2] === "login") {
      const body = (await readBody(req)) || {};
      const companyId = body.empresaId || "";
      const empresa = companyId ? await dbGetEmpresa(companyId) : null;
      if (!empresa || empresa.activo === false) { sendJson(res, 401, { error: "Empresa no encontrada." }); return; }
      const usuario = await dbGetOne(companyId, "accesoUsuarios", body.usuarioId);
      if (!usuario || usuario.activo === false || !verifyPassword(body.clave || "", usuario.claveHash)) {
        sendJson(res, 401, { error: "Usuario o clave incorrectos." });
        return;
      }
      const token = signToken({ sub: usuario.id, companyId });
      sendJson(res, 200, { token, usuario: sanitizeUsuario(usuario), empresa: { id: empresa.id, nombre: empresa.nombre } });
      return;
    }

    // --- A partir de aquí, todo requiere sesión válida; companyId sale
    //     siempre del token firmado, nunca de lo que mande el navegador. ---
    const payload = verifyToken(getBearerToken(req));
    if (!payload) { sendJson(res, 401, { error: "Sesión inválida o expirada. Vuelve a iniciar sesión." }); return; }
    const companyId = payload.companyId;

    // Crear una empresa nueva: solo un usuario con perfil de administrador
    // (de cualquier empresa ya existente) puede hacerlo. Esto reemplaza el
    // proceso manual de desplegar un servidor y una base de datos nuevos:
    // ahora es un formulario dentro de Configuración.
    if (req.method === "POST" && parts[1] === "empresas") {
      const perfiles = await dbGetAll(companyId, "accesoPerfiles");
      const usuarioActual = await dbGetOne(companyId, "accesoUsuarios", payload.sub);
      const perfilActual = usuarioActual && perfiles.find((p) => p.id === usuarioActual.perfilId);
      if (!perfilActual || perfilActual.esAdmin !== true) {
        sendJson(res, 403, { error: "Solo un administrador puede crear una empresa nueva." });
        return;
      }
      const body = (await readBody(req)) || {};
      if (!body.nombre || !String(body.nombre).trim()) { sendJson(res, 400, { error: "Debes indicar el nombre de la nueva empresa." }); return; }
      const nueva = await dbCreateEmpresa(String(body.nombre).trim());
      await sembrarEmpresaNueva(nueva.id, { rut: body.rut, rubro: body.rubro });
      sendJson(res, 200, { empresa: nueva, usuarioInicial: "Administrador del sistema", claveInicial: "admin123" });
      return;
    }

    // Eliminar una empresa por completo: solo un administrador (de
    // cualquier empresa ya existente, mismo criterio que para crear una
    // empresa nueva) puede hacerlo. Es IRREVERSIBLE -- borra en cascada
    // absolutamente todos los datos de esa empresa. Dos resguardos: no
    // se puede eliminar la empresa con la que se inició sesión ahora
    // mismo (para no quedar a medio camino de una sesión inválida), ni
    // la última empresa que quede en toda la instalación.
    if (req.method === "DELETE" && parts[1] === "empresas" && parts[2]) {
      const perfiles = await dbGetAll(companyId, "accesoPerfiles");
      const usuarioActual = await dbGetOne(companyId, "accesoUsuarios", payload.sub);
      const perfilActual = usuarioActual && perfiles.find((p) => p.id === usuarioActual.perfilId);
      if (!perfilActual || perfilActual.esAdmin !== true) {
        sendJson(res, 403, { error: "Solo un administrador puede eliminar una empresa." });
        return;
      }
      const targetId = parts[2];
      if (targetId === companyId) {
        sendJson(res, 400, { error: "No puedes eliminar la empresa con la que iniciaste sesión ahora mismo. Cambia a otra empresa e inténtalo de nuevo." });
        return;
      }
      const objetivo = await dbGetEmpresa(targetId);
      if (!objetivo) { sendJson(res, 404, { error: "Esa empresa no existe (puede que ya se haya eliminado)." }); return; }
      const todas = await dbListEmpresas();
      if (todas.length <= 1) {
        sendJson(res, 400, { error: "No puedes eliminar la última empresa de la instalación." });
        return;
      }
      await dbDeleteEmpresa(targetId);
      sendJson(res, 200, { ok: true, eliminada: { id: objetivo.id, nombre: objetivo.nombre } });
      return;
    }

    // Exportar (respaldo) todos los stores de la empresa activa como un solo
    // JSON, y luego importarlo dentro de otra empresa/instalación -- es el
    // mecanismo pensado para trasladar los datos reales de una empresa que
    // hoy vive en un servidor/BD separado hacia esta instalación única.
    if (req.method === "GET" && parts[1] === "admin" && parts[2] === "export") {
      const out = {};
      for (const store of STORES) out[store] = await dbGetAll(companyId, store);
      sendJson(res, 200, { companyId, exportadoEl: new Date().toISOString(), stores: out });
      return;
    }
    if (req.method === "POST" && parts[1] === "admin" && parts[2] === "import") {
      const perfiles = await dbGetAll(companyId, "accesoPerfiles");
      const usuarioActual = await dbGetOne(companyId, "accesoUsuarios", payload.sub);
      const perfilActual = usuarioActual && perfiles.find((p) => p.id === usuarioActual.perfilId);
      if (!perfilActual || perfilActual.esAdmin !== true) {
        sendJson(res, 403, { error: "Solo un administrador puede importar un respaldo." });
        return;
      }
      const body = (await readBody(req)) || {};
      const stores = body.stores || {};
      let importados = 0;
      let claveTemporalAsignada = 0;
      // Por seguridad, un respaldo exportado desde la app NUNCA incluye la
      // clave real de los usuarios (ni siquiera su hash: el servidor la
      // quita antes de mandar accesoUsuarios al navegador). Sin este caso
      // especial, un usuario importado así quedaría con una cuenta rota
      // (sin claveHash, imposible de validar) sin ningún aviso. En vez de
      // eso, se le asigna una clave temporal conocida para que el
      // administrador se la entregue y el usuario la cambie en Configuración.
      const CLAVE_TEMPORAL_IMPORTACION = "cambiar123";
      for (const store of Object.keys(stores)) {
        if (!STORES_SET.has(store)) continue;
        const registros = Array.isArray(stores[store]) ? stores[store] : [];
        for (const rec of registros) {
          if (!rec || !rec.id) continue;
          let toStore = rec;
          if (store === "accesoUsuarios") {
            toStore = Object.assign({}, rec);
            delete toStore.clave;
            if (!toStore.claveHash || !String(toStore.claveHash).startsWith("scrypt:")) {
              toStore.claveHash = hashPassword(CLAVE_TEMPORAL_IMPORTACION);
              claveTemporalAsignada++;
            }
          }
          await dbUpsert(companyId, store, toStore);
          importados++;
        }
      }
      sendJson(res, 200, { importados, claveTemporalAsignada, claveTemporalUsada: claveTemporalAsignada > 0 ? CLAVE_TEMPORAL_IMPORTACION : undefined });
      return;
    }

    if (req.method === "POST" && parts[1] === "ia" && parts[2] === "redactar-documento") {
      const body = (await readBody(req)) || {};
      if (!body.tipo || !body.nombre) { sendJson(res, 400, { error: "Debes indicar el tipo y el nombre del documento." }); return; }
      try {
        const contenido = await redactarDocumentoConIA(companyId, body);
        sendJson(res, 200, { contenido });
      } catch (err) {
        sendJson(res, err.statusCode || 500, { error: err.message });
      }
      return;
    }

    const store = parts[1];
    if (!STORES_SET.has(store)) { sendJson(res, 404, { error: `Store desconocido: ${store}` }); return; }

    if (req.method === "GET" && parts.length === 2) {
      const rows = await dbGetAll(companyId, store);
      sendJson(res, 200, rows);
      return;
    }

    if (req.method === "POST" && parts.length === 2) {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || !body.id) { sendJson(res, 400, { error: "El registro debe incluir un id." }); return; }
      let toStore = body;
      if (store === "accesoUsuarios") {
        const existing = await dbGetOne(companyId, store, body.id);
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
      await dbUpsert(companyId, store, toStore);
      sendJson(res, 200, store === "accesoUsuarios" ? sanitizeUsuario(toStore) : toStore);
      return;
    }

    if (req.method === "DELETE" && parts.length === 3) {
      await dbDeleteOne(companyId, store, decodeURIComponent(parts[2]));
      res.writeHead(204); res.end();
      return;
    }

    if (req.method === "DELETE" && parts.length === 2) {
      await dbClearStore(companyId, store);
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
  server.listen(PORT, () => console.log(`API de Prevención de Riesgos (multi-empresa) escuchando en el puerto ${PORT}`));
}
main().catch((err) => { console.error("No se pudo iniciar el servidor:", err); process.exit(1); });
