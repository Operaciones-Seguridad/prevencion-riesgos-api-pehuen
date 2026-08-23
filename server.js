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
  "planAccionMatriz", "eppStock", "accInvestigaciones", "ds44Obligaciones", "ds44Cumplimiento",
  "cursosObligatorios", "trabajadorCursos", "ds67Evaluaciones", "cphysAcuerdos",
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
// Normaliza el Rubro (texto libre en el store "empresa") para que
// variaciones de escritura del mismo rubro ("Construcción", "construcción
// SPA", "CONSTRUCCION") compartan el mismo grupo en catalogos_rubro --
// mismo criterio NFD que ya usa slugify() arriba.
function normRubro(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().trim().replace(/\s+/g, " ");
}

// ---------- acceso a datos: EMPRESAS (registro maestro de compañías) ----------
async function dbListEmpresas() {
  const { rows } = await pool.query("SELECT id, nombre, activo, aprobada FROM empresas WHERE activo = true ORDER BY nombre ASC");
  return rows;
}
async function dbGetEmpresa(id) {
  const { rows } = await pool.query("SELECT id, nombre, activo, aprobada FROM empresas WHERE id = $1", [id]);
  return rows[0] || null;
}
// aprobada=true para empresas creadas por un superAdmin (Configuración o
// seedIfEmpty): las está dando de alta a mano, no necesitan aprobarse a
// sí mismas. aprobada=false para el registro público (ver más abajo) --
// nace pendiente hasta que un superAdmin la apruebe.
async function dbCreateEmpresa(nombre, aprobada = true) {
  const id = slugify(nombre);
  await pool.query("INSERT INTO empresas (id, nombre, aprobada) VALUES ($1, $2, $3)", [id, nombre, aprobada]);
  return { id, nombre, activo: true, aprobada };
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
// Única consulta que cruza empresas: busca accesoUsuarios por email en TODA
// la instalación (usa el índice records_email_idx de schema.sql). Solo la
// usa el login por correo -- nunca devuelve nombres de empresa antes de
// validar la clave contra cada candidato (ver POST /api/auth/login).
async function dbFindUsuariosPorEmail(email) {
  const { rows } = await pool.query(
    "SELECT company_id, data FROM records WHERE store = 'accesoUsuarios' AND lower(data->>'email') = $1",
    [String(email).toLowerCase()]
  );
  return rows.map((r) => ({ companyId: r.company_id, data: r.data }));
}

// ---------- superAdmin (dueño de la plataforma) ----------
// Vive en una tabla separada (platform_admins, ver schema.sql), FUERA de
// STORES/STORES_SET -- ninguna ruta que el cliente pueda llamar (incluida
// la genérica POST /api/accesoUsuarios) puede alcanzarla ni escribirla.
// Solo se otorga con scripts/otorgar-superadmin.js, corrido a mano por
// quien tiene acceso directo al servidor.
async function esSuperAdmin(email) {
  if (!email) return false;
  const { rows } = await pool.query("SELECT 1 FROM platform_admins WHERE email = $1", [String(email).toLowerCase()]);
  return rows.length > 0;
}
async function getCallerEmail(companyId, payload) {
  const usuario = await dbGetOne(companyId, "accesoUsuarios", payload.sub);
  return usuario && usuario.email ? String(usuario.email).toLowerCase() : null;
}

// ---------- límite simple de intentos de registro público (por IP) ----------
// Sin CAPTCHA ni dependencias nuevas: solo frena el abuso trivial de
// POST /api/public/empresas/registro (crear empresas en masa). Se reinicia
// si el proceso se reinicia -- suficiente para este estado del producto,
// no reemplaza una defensa anti-bot real si hiciera falta más adelante.
const registroIntentosPorIp = new Map();
const REGISTRO_MAX_POR_HORA = 5;
function permitirRegistroPublico(ip) {
  const ahora = Date.now();
  const ventana = 60 * 60 * 1000;
  const lista = (registroIntentosPorIp.get(ip) || []).filter((t) => ahora - t < ventana);
  if (lista.length >= REGISTRO_MAX_POR_HORA) return false;
  lista.push(ahora);
  registroIntentosPorIp.set(ip, lista);
  return true;
}

// ---------- redacción automática de documentos con IA ----------
// Usa la API de mensajes de Anthropic (Claude) para redactar un borrador de
// política, procedimiento o manual, dando como contexto los datos reales ya
// cargados en la empresa activa: rubro, áreas, el perfil de riesgos de la
// Matriz de riesgos, los focos críticos de Accidentabilidad y un resumen
// agregado del historial real de accidentes (solo conteos, nunca el detalle
// de cada caso). Para un Procedimiento, además cruza la Matriz de riesgos
// con el mismo criterio que ya usa el PDF de Control Documental
// (matrizLineasParaDocumento en index.html): líneas cuya medida de control
// administrativa "D" coincide exactamente con el nombre del documento, para
// que el borrador cubra en detalle justo los peligros que ese procedimiento
// debe controlar. Requiere que la variable de entorno ANTHROPIC_API_KEY esté
// configurada; si no lo está, se informa un error claro en vez de fallar de
// forma confusa. Usa fetch nativo de Node (disponible desde Node 18+), sin
// agregar ninguna dependencia nueva.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = "claude-sonnet-5";

const TIPO_DOC_LABEL_IA = { politica: "una Política de Seguridad y Salud en el Trabajo (SST)", procedimiento: "un Procedimiento o Instructivo de trabajo seguro", manual: "un Manual del sistema de gestión de prevención de riesgos" };

// Mismo cálculo de nivel de riesgo que usa el frontend (index.html: nivelRiesgo).
function nivelRiesgoIA(p, c) {
  const v = (p || 0) * (c || 0);
  if (v <= 4) return "Bajo";
  if (v <= 9) return "Medio";
  if (v <= 16) return "Alto";
  return "Crítico";
}
// Mismo parseo que usa el frontend (index.html: parseControlesBullets/jerarquiaDe)
// para leer las medidas de control jerarquizadas (A-E, DS 44) de una línea de
// la matriz, ya sea desde el campo estructurado o desde el texto libre heredado.
function jerarquiaDeIA(m) {
  if (Array.isArray(m.controlesJerarquizados) && m.controlesJerarquizados.length) return m.controlesJerarquizados;
  const partirLineas = (txt) => String(txt || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const bulletRe = /^[•\-\*]?\s*([A-E])\)\s*(.*)$/i;
  return partirLineas(m.controles).map((linea) => {
    const bm = linea.match(bulletRe);
    return { jerarquia: bm ? bm[1].toUpperCase() : "", texto: bm ? bm[2].trim() : linea };
  });
}

async function redactarDocumentoConIA(companyId, { tipo, nombre, contextoAdicional, documentoId }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("La redacción con IA no está configurada en este servidor: falta la variable de entorno ANTHROPIC_API_KEY.");
    err.statusCode = 500;
    throw err;
  }
  const [empresa, areas, matriz, accidentes, catalogosExtra] = await Promise.all([
    dbGetAll(companyId, "empresa"),
    dbGetAll(companyId, "areas"),
    dbGetAll(companyId, "matriz"),
    dbGetAll(companyId, "accidentes"),
    dbGetAll(companyId, "catalogosExtra"),
  ]);
  const razonSocial = (empresa[0] && empresa[0].razonSocial) || "la empresa";
  const rubro = (empresa[0] && empresa[0].rubro) || "no especificado";
  const nombresAreas = areas.map((a) => a.nombre).filter(Boolean).join(", ") || "no especificadas";
  const areaNombre = (id) => (areas.find((a) => a.id === id) || {}).nombre || "";
  const tipoDescripcion = TIPO_DOC_LABEL_IA[tipo] || "un documento del sistema de gestión de prevención de riesgos";

  // Perfil de riesgos: las líneas de la Matriz más críticas (por
  // probabilidad×consecuencia), para que el borrador se aterrice a los
  // peligros reales de la empresa en vez de hablar en términos genéricos.
  const perfilRiesgos = matriz
    .slice()
    .sort((a, b) => (b.probabilidad || 0) * (b.consecuencia || 0) - (a.probabilidad || 0) * (a.consecuencia || 0))
    .slice(0, 15)
    .map((m) => `- [${nivelRiesgoIA(m.probabilidad, m.consecuencia)}] ${areaNombre(m.areaId) || "Sin área"}: ${m.peligro || "peligro sin describir"} → ${m.riesgo || "riesgo sin describir"}`)
    .join("\n");

  const focosCriticos = ((catalogosExtra.find((c) => c.id === "focoCritico") || {}).valores || []).join(", ");

  const porTipo = {};
  accidentes.forEach((a) => { const k = a.tipo || "sin tipo"; porTipo[k] = (porTipo[k] || 0) + 1; });
  const resumenAccidentes = accidentes.length
    ? Object.entries(porTipo).map(([k, n]) => `${n} de tipo "${k}"`).join(", ") + ` (${accidentes.length} registros en total)`
    : "sin accidentes/incidentes registrados";

  // Para un Procedimiento, cruza la Matriz con el mismo criterio que el PDF
  // de Control Documental: líneas cuya medida de control administrativa (D)
  // está vinculada a este documento por id (documentoId, fuente de verdad,
  // solo aplica cuando se está redactando un documento ya guardado) o,
  // como respaldo, cuyo texto coincide exactamente (normalizado) con el
  // nombre del documento -- mismo criterio doble que matrizLineasParaDocumento
  // en el frontend (index.html).
  let riesgosEspecificos = "";
  if (tipo === "procedimiento" && (nombre || documentoId)) {
    const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const keyTexto = norm(nombre);
    const lineas = matriz.filter((m) => jerarquiaDeIA(m).some((it) => it.jerarquia === "D" && (it.documentoId === documentoId || (nombre && norm(it.texto) === keyTexto))));
    if (lineas.length) {
      riesgosEspecificos = lineas
        .map((m) => `- Área ${areaNombre(m.areaId) || "sin área"}, ${[m.proceso, m.actividad].filter(Boolean).join(" / ") || "sin proceso/actividad"}: peligro "${m.peligro || "—"}", riesgo "${m.riesgo || "—"}" (nivel ${nivelRiesgoIA(m.probabilidad, m.consecuencia)})`)
        .join("\n");
    }
  }

  const prompt = `Eres un prevencionista de riesgos experto en normativa chilena (Ley N°16.744, DS N°44/2024, DS N°594). Redacta el contenido completo de ${tipoDescripcion} para la siguiente empresa:

- Razón social: ${razonSocial}
- Rubro: ${rubro}
- Áreas de la empresa: ${nombresAreas}
- Nombre del documento a redactar: "${nombre}"
${contextoAdicional ? `- Contexto adicional indicado por el usuario: ${contextoAdicional}` : ""}

Datos reales ya cargados en el sistema de esta empresa, para que el contenido sea específico y no genérico:
- Perfil de riesgos (líneas más críticas de la Matriz de riesgos vigente, de mayor a menor nivel):
${perfilRiesgos || "  Sin líneas registradas todavía en la Matriz de riesgos."}
- Focos críticos de accidentabilidad registrados: ${focosCriticos || "no registrados"}
- Historial real de accidentes/incidentes: ${resumenAccidentes}
${riesgosEspecificos ? `\nEste documento está registrado en la Matriz de riesgos como medida de control administrativo (jerarquía D, DS 44) para estas líneas específicas -- el contenido DEBE cubrir en detalle exactamente estos peligros y riesgos, con los pasos/medidas concretas para controlarlos:\n${riesgosEspecificos}\n` : ""}
Redacta el contenido en español de Chile, en formato de texto plano con títulos numerados (1. Objetivo, 2. Alcance, 3. ...), listo para pegar directamente en el campo "Contenido" del documento. No agregues portada, tabla de control de versiones ni hoja de firmas (eso ya lo genera la app por separado). Sé concreto y aterrizado a los datos reales indicados arriba (rubro, áreas, riesgos, focos críticos), no genérico.`;

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

const JERARQUIAS_VALIDAS = new Set(["A", "B", "C", "D", "E"]);
function clampEntero(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ---------- sugerencia de líneas nuevas para la Matriz de riesgos con IA ----------
// Le pide a Claude que proponga líneas nuevas (peligro/riesgo/controles) para
// la Matriz de riesgos de la empresa activa, en JSON estructurado. Usa como
// contexto las líneas YA existentes para que el resultado "complemente" la
// matriz sin repetir lo ya cargado (si la matriz está vacía, simplemente no
// hay nada que evitar duplicar, y el resultado equivale a generarla desde
// cero). Las sugerencias NUNCA se guardan solas: el frontend las muestra en
// una previsualización con checkbox y el usuario decide cuáles agregar de
// verdad (mismo criterio ya usado en redactarDocumentoConIA).
async function sugerirMatrizConIA(companyId, { contextoAdicional, cantidad }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("La sugerencia con IA no está configurada en este servidor: falta la variable de entorno ANTHROPIC_API_KEY.");
    err.statusCode = 500;
    throw err;
  }
  const cantidadPedida = clampEntero(cantidad, 1, 20, 8);
  const [empresa, areas, matriz] = await Promise.all([
    dbGetAll(companyId, "empresa"),
    dbGetAll(companyId, "areas"),
    dbGetAll(companyId, "matriz"),
  ]);
  const razonSocial = (empresa[0] && empresa[0].razonSocial) || "la empresa";
  const rubro = (empresa[0] && empresa[0].rubro) || "no especificado";
  const areaNombre = (id) => (areas.find((a) => a.id === id) || {}).nombre || "";
  const listaAreas = areas.length
    ? areas.map((a) => `- id "${a.id}": ${a.nombre}`).join("\n")
    : "  (esta empresa todavía no tiene áreas registradas; usa areaId null)";

  const TOPE_LINEAS_EXISTENTES = 100;
  const lineasExistentes = matriz
    .slice(0, TOPE_LINEAS_EXISTENTES)
    .map((m) => `- ${areaNombre(m.areaId) || "Sin área"} / ${[m.proceso, m.actividad].filter(Boolean).join(" / ") || "sin proceso/actividad"}: ${m.peligro || "—"} → ${m.riesgo || "—"}`)
    .join("\n");
  const notaTruncado = matriz.length > TOPE_LINEAS_EXISTENTES ? `\n  (y ${matriz.length - TOPE_LINEAS_EXISTENTES} línea(s) más no listadas aquí)` : "";

  const prompt = `Eres un prevencionista de riesgos experto en normativa chilena (Ley N°16.744, DS N°44/2024, DS N°594), especialista en construir Matrices de Identificación de Peligros y Evaluación de Riesgos (IPER).

Empresa:
- Razón social: ${razonSocial}
- Rubro: ${rubro}
- Áreas registradas (usa EXACTAMENTE uno de estos "id" en el campo areaId de cada línea que propongas, o null si ninguna aplica):
${listaAreas}
${contextoAdicional ? `- Contexto adicional indicado por el usuario: ${contextoAdicional}\n` : ""}
Líneas que YA existen en la Matriz de riesgos de esta empresa (no las repitas; tu tarea es COMPLEMENTAR, proponiendo peligros/riesgos distintos a los ya cubiertos${matriz.length ? "" : " -- como todavía no hay ninguna línea, proponlas desde cero para el rubro indicado"}):
${lineasExistentes || "  (todavía no hay ninguna línea cargada)"}${notaTruncado}

Propón exactamente ${cantidadPedida} línea(s) NUEVA(s) para la Matriz de riesgos, relevantes al rubro y áreas de esta empresa. Para cada línea, sigue la jerarquía de controles del DS 44 (Eliminación, Sustitución, Control de ingeniería, Control administrativo, EPP): incluye 2 a 4 medidas de control abarcando distintos niveles de esa jerarquía, y NUNCA dejes el EPP (jerarquía E) como única medida de control.

Responde ÚNICAMENTE con un array JSON válido (sin texto antes ni después, sin bloques de código markdown), con esta forma exacta:
[{"areaId": "id de área o null", "proceso": "...", "actividad": "...", "categoria": "Físico|Químico|Biológico|Ergonómico|Psicosocial|otro texto breve", "peligro": "...", "riesgo": "...", "probabilidad": 1, "consecuencia": 1, "controlesJerarquizados": [{"jerarquia": "A", "texto": "..."}]}]

probabilidad y consecuencia son enteros de 1 a 5. jerarquia es una sola letra A, B, C, D o E.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      // Cada línea (peligro/riesgo/2-4 medidas de control con texto en
      // español) puede pesar varios cientos de tokens; con un tope fijo,
      // pedir el máximo de 20 líneas cortaba la respuesta a la mitad y
      // dejaba un JSON incompleto (JSON.parse fallaba con un mensaje
      // confuso). Se escala con la cantidad pedida en vez de un valor fijo.
      max_tokens: Math.min(8000, 800 + cantidadPedida * 400),
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

  let crudo;
  try {
    // Extrae el array JSON aunque venga envuelto en bloques de código
    // markdown o con algo de texto antes/después (a pesar de la
    // instrucción de responder solo JSON, el modelo a veces lo agrega).
    const inicio = texto.indexOf("[");
    const fin = texto.lastIndexOf("]");
    if (inicio === -1 || fin === -1 || fin < inicio) throw new Error("sin array JSON");
    crudo = JSON.parse(texto.slice(inicio, fin + 1));
  } catch (e) {
    const cortada = data.stop_reason === "max_tokens";
    const err = new Error(cortada
      ? "La respuesta de la IA fue demasiado larga y se cortó a la mitad. Pide menos líneas e intenta de nuevo."
      : "La IA no devolvió un formato válido, intenta de nuevo.");
    err.statusCode = 502;
    throw err;
  }
  if (!Array.isArray(crudo)) {
    const err = new Error("La IA no devolvió un formato válido, intenta de nuevo.");
    err.statusCode = 502;
    throw err;
  }

  const areaIds = new Set(areas.map((a) => a.id));
  const sugerencias = crudo.slice(0, cantidadPedida).map((m) => ({
    areaId: m && areaIds.has(m.areaId) ? m.areaId : null,
    proceso: (m && String(m.proceso || "").trim()) || "",
    actividad: (m && String(m.actividad || "").trim()) || "",
    categoria: (m && String(m.categoria || "").trim()) || "",
    peligro: (m && String(m.peligro || "").trim()) || "",
    riesgo: (m && String(m.riesgo || "").trim()) || "",
    probabilidad: clampEntero(m && m.probabilidad, 1, 5, 3),
    consecuencia: clampEntero(m && m.consecuencia, 1, 5, 3),
    controlesJerarquizados: (m && Array.isArray(m.controlesJerarquizados) ? m.controlesJerarquizados : [])
      .filter((c) => c && JERARQUIAS_VALIDAS.has(String(c.jerarquia || "").toUpperCase()))
      .map((c) => ({ jerarquia: String(c.jerarquia).toUpperCase(), texto: String(c.texto || "").trim(), responsable: "", plazo: "" })),
  }));

  return sugerencias;
}

const TIPOS_ITEM_FORMATO_VALIDOS = new Set(["check", "texto"]);

// ---------- sugerencia de ítems para un formato de inspección/observación con IA ----------
// Igual criterio que sugerirMatrizConIA: nunca se guarda sola, el frontend
// agrega las sugerencias a la misma tabla editable (currentFmtItems) que ya
// usa el constructor manual y la importación desde Excel, así que sirve
// tanto para armar un formato nuevo como para completar uno ya existente
// (basta con que el frontend ya haya cargado sus ítems ahí antes de pedir
// sugerencias).
async function sugerirFormatoInspeccionConIA(companyId, { tema, categoria, contextoAdicional, itemsExistentes, cantidad }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("La sugerencia con IA no está configurada en este servidor: falta la variable de entorno ANTHROPIC_API_KEY.");
    err.statusCode = 500;
    throw err;
  }
  const temaTexto = String(tema || "").trim();
  if (!temaTexto) {
    const err = new Error('Debes indicar el "Nombre del formato" antes de pedir ítems sugeridos, para que la IA sepa sobre qué tema proponerlos.');
    err.statusCode = 400;
    throw err;
  }
  const cantidadPedida = clampEntero(cantidad, 1, 20, 8);
  const [empresa, matriz] = await Promise.all([
    dbGetAll(companyId, "empresa"),
    dbGetAll(companyId, "matriz"),
  ]);
  const razonSocial = (empresa[0] && empresa[0].razonSocial) || "la empresa";
  const rubro = (empresa[0] && empresa[0].rubro) || "no especificado";

  // Acota el perfil de riesgos al tema del formato (a diferencia de
  // redactarDocumentoConIA, que usa las líneas más críticas sin filtrar):
  // busca líneas cuyo peligro/riesgo/categoría/actividad/proceso comparta
  // alguna palabra con el tema. Si ninguna coincide, cae al listado
  // general de las más críticas (mismo criterio de "fallback silencioso"
  // que usa redactarDocumentoConIA cuando no hay coincidencia específica).
  const normPalabras = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const palabrasTema = new Set(normPalabras(temaTexto));
  const textoLinea = (m) => [m.peligro, m.riesgo, m.categoria, m.actividad, m.proceso].filter(Boolean).join(" ");
  const nivel = (m) => (m.probabilidad || 0) * (m.consecuencia || 0);
  let relevantes = palabrasTema.size
    ? matriz.filter((m) => normPalabras(textoLinea(m)).some((w) => palabrasTema.has(w)))
    : [];
  if (!relevantes.length) relevantes = matriz.slice().sort((a, b) => nivel(b) - nivel(a));
  const perfilRiesgos = relevantes.slice(0, 15).map((m) => `- ${m.peligro || "peligro sin describir"} → ${m.riesgo || "riesgo sin describir"}`).join("\n");

  const CATEGORIA_DESC = { ambos: "tanto para Inspección como para Observación", inspeccion: "para una Inspección", observacion: "para una Observación" };
  const categoriaDesc = CATEGORIA_DESC[categoria] || "para un formato de inspección/observación";
  const existentesTexto = (Array.isArray(itemsExistentes) ? itemsExistentes : []).filter(Boolean).map((t) => `- ${t}`).join("\n");

  const prompt = `Eres un prevencionista de riesgos experto en normativa chilena (Ley N°16.744, DS N°44/2024, DS N°594). Estás construyendo un formato/checklist ${categoriaDesc}, llamado "${temaTexto}".

Empresa:
- Razón social: ${razonSocial}
- Rubro: ${rubro}
${contextoAdicional ? `- Contexto adicional indicado por el usuario: ${contextoAdicional}\n` : ""}
Peligros/riesgos reales de la empresa relacionados con este tema (Matriz de riesgos vigente, cuando aplica):
${perfilRiesgos || "  Sin líneas relacionadas registradas todavía en la Matriz de riesgos."}

Ítems que YA están en este formato (no los repitas; tu tarea es COMPLEMENTAR)${existentesTexto ? ":" : " (todavía no hay ninguno)."}
${existentesTexto}

Propón exactamente ${cantidadPedida} ítems NUEVOS de checklist, concretos y verificables en terreno por un inspector. Para cada ítem decide el tipo de respuesta: "check" si se responde Cumple/No cumple/N/A (la mayoría de los casos), o "texto" SOLO cuando de verdad haga falta anotar un dato libre (una cantidad, una fecha, un nombre, una medición).

Responde ÚNICAMENTE con un array JSON válido (sin texto antes ni después, sin bloques de código markdown), con esta forma exacta:
[{"text": "...", "tipo": "check"}]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: Math.min(4000, 400 + cantidadPedida * 120),
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

  let crudo;
  try {
    const inicio = texto.indexOf("[");
    const fin = texto.lastIndexOf("]");
    if (inicio === -1 || fin === -1 || fin < inicio) throw new Error("sin array JSON");
    crudo = JSON.parse(texto.slice(inicio, fin + 1));
  } catch (e) {
    const cortada = data.stop_reason === "max_tokens";
    const err = new Error(cortada
      ? "La respuesta de la IA fue demasiado larga y se cortó a la mitad. Pide menos ítems e intenta de nuevo."
      : "La IA no devolvió un formato válido, intenta de nuevo.");
    err.statusCode = 502;
    throw err;
  }
  if (!Array.isArray(crudo)) {
    const err = new Error("La IA no devolvió un formato válido, intenta de nuevo.");
    err.statusCode = 502;
    throw err;
  }

  const sugerencias = crudo
    .slice(0, cantidadPedida)
    .map((it) => ({
      text: (it && String(it.text || "").trim()) || "",
      tipo: it && TIPOS_ITEM_FORMATO_VALIDOS.has(String(it.tipo || "").toLowerCase()) ? String(it.tipo).toLowerCase() : "check",
    }))
    .filter((it) => it.text);

  return sugerencias;
}

// ---------- redacción de un hallazgo/observación con IA ----------
// A partir de una nota breve/informal que el inspector ya escribió en
// terreno, le da forma de descripción formal. A diferencia de las otras
// dos funciones de IA, no necesita el perfil de riesgos completo de la
// empresa: es una redacción puntual de lo que el inspector ya observó, no
// un documento que deba cubrir todo el perfil de riesgo.
async function redactarHallazgoConIA(companyId, { notaBreve, nivel, areaNombre, tipoRegistro, formatoNombre, descripcionInspeccion }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("La redacción con IA no está configurada en este servidor: falta la variable de entorno ANTHROPIC_API_KEY.");
    err.statusCode = 500;
    throw err;
  }
  const notaTexto = String(notaBreve || "").trim();
  if (!notaTexto) {
    const err = new Error("Escribe primero una nota breve del hallazgo (aunque sea informal) para que la IA la redacte en forma más formal.");
    err.statusCode = 400;
    throw err;
  }
  const [empresa] = await Promise.all([dbGetAll(companyId, "empresa")]);
  const razonSocial = (empresa[0] && empresa[0].razonSocial) || "la empresa";
  const rubro = (empresa[0] && empresa[0].rubro) || "no especificado";
  const NIVEL_LABEL_IA = { bajo: "Bajo", medio: "Medio", alto: "Alto", critico: "Crítico" };
  const tipoRegistroTexto = tipoRegistro === "observacion" ? "una Observación" : "una Inspección";

  const prompt = `Eres un prevencionista de riesgos experto en normativa chilena (DS N°44/2024, DS N°594, Ley N°16.744). Redacta en español de Chile la descripción formal de un hallazgo detectado durante ${tipoRegistroTexto} de seguridad en ${razonSocial} (rubro: ${rubro})${formatoNombre ? `, formato "${formatoNombre}"` : ""}${areaNombre ? `, área "${areaNombre}"` : ""}.
${descripcionInspeccion ? `Contexto general de esta visita: ${descripcionInspeccion}\n` : ""}Nivel de riesgo asignado por el inspector: ${NIVEL_LABEL_IA[nivel] || "Bajo"}.
Nota breve/informal escrita por el inspector en terreno: "${notaTexto}"

Redacta la descripción del hallazgo en 2 a 4 frases, en tono técnico y objetivo, lista para quedar registrada formalmente. No inventes datos que la nota no menciona (no agregues números, nombres ni fechas que no estén en la nota) -- solo dale forma clara y profesional a lo que el inspector ya escribió. Responde únicamente con el texto de la descripción, sin títulos, comillas ni texto adicional.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 600,
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
  const descripcion = (data.content || []).map((b) => b.text || "").join("\n").trim();
  if (!descripcion) {
    const err = new Error("El servicio de IA no devolvió contenido.");
    err.statusCode = 502;
    throw err;
  }
  return descripcion;
}

// ---------- siembra de datos por defecto de una empresa nueva ----------
// Reproduce lo que antes había que hacer a mano (desplegar un servidor y una
// base de datos nuevos en Render): crea los perfiles de acceso estándar, el
// primer usuario administrador, el catálogo de protocolos de vigilancia de
// salud y el checklist de compromisos, todo ya asociado al company_id de la
// empresa recién creada.
//
// Sin adminNombre/adminEmail/adminClave (el flujo interno de Configuración,
// ahora exclusivo de superAdmin), sigue sembrando el usuario/clave fijos de
// siempre ("Administrador del sistema" / admin123) para no cambiar ese flujo.
// Con esos datos (el registro público nuevo), siembra al administrador que
// la empresa recién creada eligió, con SU correo y SU clave desde el
// principio -- nunca la clave fija, porque acá nadie sabe de antemano que
// tiene que cambiarla. Devuelve {usuarioId, nombreAdmin, claveAdmin} para
// que cada caller arme la respuesta/token que necesite.
async function sembrarEmpresaNueva(companyId, { rut, rubro, adminNombre, adminEmail, adminClave } = {}) {
  const perfilAdminId = crypto.randomUUID();
  const perfilPrevId = crypto.randomUUID();
  const perfilSupervisorId = crypto.randomUUID();
  const perfilTrabajadorId = crypto.randomUUID();
  const TODAS_LAS_VISTAS = ["dashboard", "realizar-inspecciones", "inspecciones", "matriz", "vigilancia", "programa", "capacitacion", "accidentabilidad", "seguridad", "epp", "cumplimiento", "riohys", "documentos", "cphys", "emergencia", "compromisos", "config"];
  await dbUpsert(companyId, "accesoPerfiles", { id: perfilAdminId, nombre: "Administrador", esAdmin: true, vistas: TODAS_LAS_VISTAS.slice() });
  await dbUpsert(companyId, "accesoPerfiles", { id: perfilPrevId, nombre: "Prevencionista de Riesgos", esAdmin: false, vistas: TODAS_LAS_VISTAS.filter((v) => v !== "config") });
  await dbUpsert(companyId, "accesoPerfiles", { id: perfilSupervisorId, nombre: "Jefe de Obra / Supervisor", esAdmin: false, vistas: ["dashboard", "realizar-inspecciones", "inspecciones", "matriz", "programa", "capacitacion", "accidentabilidad", "emergencia", "compromisos"] });
  await dbUpsert(companyId, "accesoPerfiles", { id: perfilTrabajadorId, nombre: "Trabajador", esAdmin: false, descargaDashboard: false, vistas: ["dashboard", "realizar-inspecciones"] });
  const usuarioId = crypto.randomUUID();
  const nombreAdmin = (adminNombre && String(adminNombre).trim()) || "Administrador del sistema";
  const claveAdmin = adminClave || "admin123";
  const usuarioAdmin = { id: usuarioId, nombre: nombreAdmin, cargo: "Administrador", perfilId: perfilAdminId, claveHash: hashPassword(claveAdmin), activo: true };
  if (adminEmail) usuarioAdmin.email = String(adminEmail).trim().toLowerCase();
  await dbUpsert(companyId, "accesoUsuarios", usuarioAdmin);

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
  return { usuarioId, nombreAdmin, claveAdmin };
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

    // --- Endpoints públicos (sin autenticación) ---
    // NOTA: ya NO existe un listado público de empresas ni de usuarios --
    // desde que Pehuén vende acceso directo a empresas sin relación entre
    // sí, ninguna solicitud sin sesión puede enterarse de qué otras
    // empresas o usuarios existen en la instalación. El login por correo
    // de abajo es la única consulta que cruza empresas, y solo compara
    // contraseñas (nunca devuelve nombres antes de validar la clave).

    // Login: acepta DOS formas.
    // 1) {email, clave} (nueva, recomendada): busca ese correo en TODA la
    //    instalación (dbFindUsuariosPorEmail) y valida la clave contra cada
    //    candidato encontrado -- si calza en más de una empresa (un mismo
    //    correo puede administrar varias, caso real), no emite token: pide
    //    elegir cuál con {requiereSeleccion:true, empresas:[...]} usando
    //    SOLO esas empresas ya autenticadas por clave, nunca el listado
    //    completo. El cliente reenvía {email, clave, empresaId} para
    //    terminar de iniciar sesión en esa empresa puntual.
    // 2) {empresaId, usuarioId, clave} (la de siempre, SIN cambios): se
    //    mantiene para que los clientes reales de hoy, que todavía no
    //    tienen correo cargado, sigan entrando exactamente igual.
    if (req.method === "POST" && parts[1] === "auth" && parts[2] === "login") {
      const body = (await readBody(req)) || {};
      const MSG_PENDIENTE = "Tu empresa todavía está pendiente de aprobación. Te avisaremos apenas esté activa.";
      if (body.email) {
        const email = String(body.email).trim().toLowerCase();
        const clave = body.clave || "";
        const candidatos = await dbFindUsuariosPorEmail(email);
        const conClaveOk = candidatos.filter((c) => c.data.activo !== false && verifyPassword(clave, c.data.claveHash));
        if (!conClaveOk.length) { sendJson(res, 401, { error: "Correo o clave incorrectos." }); return; }
        // Resolver la empresa de cada candidato válido y quedarse solo con
        // las activas -- las pendientes de aprobación se filtran acá mismo
        // (no tiene sentido ofrecerlas en el selector de "elige cuál").
        const conEmpresa = [];
        for (const c of conClaveOk) {
          const e = await dbGetEmpresa(c.companyId);
          if (e && e.activo !== false) conEmpresa.push({ ...c, empresa: e });
        }
        if (!conEmpresa.length) { sendJson(res, 401, { error: "Correo o clave incorrectos." }); return; }
        const aprobadas = conEmpresa.filter((c) => c.empresa.aprobada !== false);
        if (!aprobadas.length) {
          // Ya probó que la clave es correcta -- informar el motivo real
          // no es una filtración de datos ajenos.
          sendJson(res, 403, { error: MSG_PENDIENTE, pendiente: true });
          return;
        }
        let elegido = aprobadas[0];
        if (aprobadas.length > 1) {
          elegido = body.empresaId ? aprobadas.find((v) => v.companyId === body.empresaId) : null;
          if (!elegido) {
            sendJson(res, 200, { requiereSeleccion: true, empresas: aprobadas.map((v) => ({ id: v.empresa.id, nombre: v.empresa.nombre })) });
            return;
          }
        }
        const token = signToken({ sub: elegido.data.id, companyId: elegido.companyId });
        sendJson(res, 200, { token, usuario: sanitizeUsuario(elegido.data), empresa: { id: elegido.empresa.id, nombre: elegido.empresa.nombre }, superAdmin: await esSuperAdmin(email) });
        return;
      }
      const companyId = body.empresaId || "";
      const empresa = companyId ? await dbGetEmpresa(companyId) : null;
      if (!empresa || empresa.activo === false) { sendJson(res, 401, { error: "Empresa no encontrada." }); return; }
      const usuario = await dbGetOne(companyId, "accesoUsuarios", body.usuarioId);
      if (!usuario || usuario.activo === false || !verifyPassword(body.clave || "", usuario.claveHash)) {
        sendJson(res, 401, { error: "Usuario o clave incorrectos." });
        return;
      }
      if (empresa.aprobada === false) { sendJson(res, 403, { error: MSG_PENDIENTE, pendiente: true }); return; }
      const token = signToken({ sub: usuario.id, companyId });
      sendJson(res, 200, { token, usuario: sanitizeUsuario(usuario), empresa: { id: empresa.id, nombre: empresa.nombre }, superAdmin: await esSuperAdmin(usuario.email) });
      return;
    }

    // Alta pública de empresa (autoservicio, sin sesión previa): crea la
    // empresa y su primer usuario administrador con el correo/clave que
    // ESA persona eligió (nunca la clave fija admin123 -- acá nadie sabe de
    // antemano que tiene que cambiarla), pero NACE PENDIENTE DE APROBACIÓN
    // (aprobada=false) -- no emite token ni deja entrar todavía, para que
    // el dueño de la plataforma decida quién puede empezar a usarla de
    // verdad. Un superAdmin la aprueba con POST /api/empresas/:id/aprobar.
    // Rate-limit simple por IP para frenar abuso trivial.
    if (req.method === "POST" && parts[1] === "public" && parts[2] === "empresas" && parts[3] === "registro") {
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "desconocida";
      if (!permitirRegistroPublico(ip)) {
        sendJson(res, 429, { error: "Demasiados intentos de registro desde esta conexión. Intenta de nuevo más tarde." });
        return;
      }
      const body = (await readBody(req)) || {};
      const nombreEmpresa = String(body.nombre || "").trim();
      const adminNombre = String(body.adminNombre || "").trim();
      const adminEmail = String(body.adminEmail || "").trim().toLowerCase();
      const adminClave = String(body.adminClave || "");
      if (!nombreEmpresa) { sendJson(res, 400, { error: "Indica el nombre de tu empresa." }); return; }
      if (!adminNombre) { sendJson(res, 400, { error: "Indica tu nombre." }); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) { sendJson(res, 400, { error: "Indica un correo válido." }); return; }
      if (adminClave.length < 8) { sendJson(res, 400, { error: "La clave debe tener al menos 8 caracteres." }); return; }
      // A propósito NO se rechaza un correo ya usado en otra empresa: un
      // mismo correo puede administrar varias empresas (ver login por
      // correo más arriba) -- cada empresa guarda su propio usuario/clave
      // para ese correo, de forma independiente.
      const nueva = await dbCreateEmpresa(nombreEmpresa, false);
      await sembrarEmpresaNueva(nueva.id, { rut: body.rut, rubro: body.rubro, adminNombre, adminEmail, adminClave });
      sendJson(res, 200, { pendiente: true, empresa: { id: nueva.id, nombre: nueva.nombre } });
      return;
    }

    // --- A partir de aquí, todo requiere sesión válida; companyId sale
    //     siempre del token firmado, nunca de lo que mande el navegador. ---
    const payload = verifyToken(getBearerToken(req));
    if (!payload) { sendJson(res, 401, { error: "Sesión inválida o expirada. Vuelve a iniciar sesión." }); return; }
    const companyId = payload.companyId;

    // Estado de la sesión actual: a qué usuario/empresa pertenece este
    // token (así el frontend no necesita cachear nada en localStorage más
    // que el token mismo -- la fuente de verdad es siempre el servidor) y
    // si es superAdmin frente a la plataforma. superAdmin se recalcula en
    // cada llamada contra platform_admins, nunca se mete en el token -- así
    // revocarlo es inmediato, sin esperar 14 días a que expire un token ya
    // emitido.
    if (req.method === "GET" && parts[1] === "me") {
      const empresaActual = await dbGetEmpresa(companyId);
      const email = await getCallerEmail(companyId, payload);
      sendJson(res, 200, {
        usuarioId: payload.sub,
        empresa: empresaActual ? { id: empresaActual.id, nombre: empresaActual.nombre } : null,
        superAdmin: await esSuperAdmin(email),
      });
      return;
    }

    // Listado completo de empresas: reemplaza al antiguo GET /api/public/empresas
    // (ahora cerrado) para la tabla de Configuración -- exclusivo de
    // superAdmin, igual criterio que crear/eliminar cualquier empresa.
    if (req.method === "GET" && parts[1] === "empresas") {
      const email = await getCallerEmail(companyId, payload);
      if (!(await esSuperAdmin(email))) {
        sendJson(res, 403, { error: "Solo el administrador de la plataforma puede ver el listado completo de empresas." });
        return;
      }
      sendJson(res, 200, await dbListEmpresas());
      return;
    }

    // Aprobar una empresa registrada desde afuera (POST /api/public/empresas/registro
    // la crea pendiente -- ver ahí): exclusivo de superAdmin. Se chequea
    // ANTES que "crear empresa" de abajo porque ese otro bloque solo mira
    // parts[1]==="empresas" sin más, y matchearía esta ruta también.
    if (req.method === "POST" && parts[1] === "empresas" && parts[2] && parts[3] === "aprobar") {
      const email = await getCallerEmail(companyId, payload);
      if (!(await esSuperAdmin(email))) {
        sendJson(res, 403, { error: "Solo el administrador de la plataforma puede aprobar una empresa." });
        return;
      }
      const objetivo = await dbGetEmpresa(parts[2]);
      if (!objetivo) { sendJson(res, 404, { error: "Esa empresa no existe." }); return; }
      await pool.query("UPDATE empresas SET aprobada = true WHERE id = $1", [parts[2]]);
      sendJson(res, 200, { ok: true, empresa: { id: objetivo.id, nombre: objetivo.nombre } });
      return;
    }

    // Crear una empresa nueva DESDE ADENTRO de la app (Configuración): a
    // diferencia del registro público (que es la puerta de entrada para
    // clientes nuevos), esto es un privilegio de alcance de toda la
    // plataforma -- crear una empresa no es "gestionar la mía propia" --
    // así que ahora es exclusivo de superAdmin, no de cualquier esAdmin.
    if (req.method === "POST" && parts[1] === "empresas") {
      const email = await getCallerEmail(companyId, payload);
      if (!(await esSuperAdmin(email))) {
        sendJson(res, 403, { error: "Solo el administrador de la plataforma puede crear una empresa nueva desde aquí." });
        return;
      }
      const body = (await readBody(req)) || {};
      if (!body.nombre || !String(body.nombre).trim()) { sendJson(res, 400, { error: "Debes indicar el nombre de la nueva empresa." }); return; }
      const nueva = await dbCreateEmpresa(String(body.nombre).trim());
      const { nombreAdmin, claveAdmin } = await sembrarEmpresaNueva(nueva.id, { rut: body.rut, rubro: body.rubro });
      sendJson(res, 200, { empresa: nueva, usuarioInicial: nombreAdmin, claveInicial: claveAdmin });
      return;
    }

    // Eliminar una empresa por completo. Es IRREVERSIBLE -- borra en
    // cascada absolutamente todos los datos de esa empresa. Regla nueva
    // (reemplaza la anterior, que era exactamente al revés):
    //   - superAdmin: puede eliminar CUALQUIER empresa (dar de baja un
    //     cliente, por ejemplo).
    //   - administrador normal (esAdmin, no superAdmin): SOLO puede
    //     eliminar su propia empresa (la del token con el que inició
    //     sesión) -- cerrar su propia cuenta si así lo decide. Cualquier
    //     otro id, 403.
    if (req.method === "DELETE" && parts[1] === "empresas" && parts[2]) {
      const targetId = parts[2];
      const email = await getCallerEmail(companyId, payload);
      const esSuper = await esSuperAdmin(email);
      if (!esSuper) {
        const perfiles = await dbGetAll(companyId, "accesoPerfiles");
        const usuarioActual = await dbGetOne(companyId, "accesoUsuarios", payload.sub);
        const perfilActual = usuarioActual && perfiles.find((p) => p.id === usuarioActual.perfilId);
        if (!perfilActual || perfilActual.esAdmin !== true) {
          sendJson(res, 403, { error: "Solo un administrador puede eliminar una empresa." });
          return;
        }
        if (targetId !== companyId) {
          sendJson(res, 403, { error: "Solo puedes eliminar tu propia empresa." });
          return;
        }
      }
      const objetivo = await dbGetEmpresa(targetId);
      if (!objetivo) { sendJson(res, 404, { error: "Esa empresa no existe (puede que ya se haya eliminado)." }); return; }
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

    if (req.method === "POST" && parts[1] === "ia" && parts[2] === "sugerir-matriz") {
      const body = (await readBody(req)) || {};
      try {
        const sugerencias = await sugerirMatrizConIA(companyId, body);
        sendJson(res, 200, { sugerencias });
      } catch (err) {
        sendJson(res, err.statusCode || 500, { error: err.message });
      }
      return;
    }

    if (req.method === "POST" && parts[1] === "ia" && parts[2] === "sugerir-formato-inspeccion") {
      const body = (await readBody(req)) || {};
      try {
        const sugerencias = await sugerirFormatoInspeccionConIA(companyId, body);
        sendJson(res, 200, { sugerencias });
      } catch (err) {
        sendJson(res, err.statusCode || 500, { error: err.message });
      }
      return;
    }

    if (req.method === "POST" && parts[1] === "ia" && parts[2] === "redactar-hallazgo") {
      const body = (await readBody(req)) || {};
      try {
        const descripcion = await redactarHallazgoConIA(companyId, body);
        sendJson(res, 200, { descripcion });
      } catch (err) {
        sendJson(res, err.statusCode || 500, { error: err.message });
      }
      return;
    }

    // Catálogo de Proceso/Actividad/Categoría/Peligro compartido por Rubro
    // (tabla catalogos_rubro, deliberadamente NO aislada por company_id --
    // ver el comentario en schema.sql). El rubro nunca viaja desde el
    // cliente: siempre se lee del store "empresa" de la empresa del token.
    if (req.method === "GET" && parts[1] === "catalogo-rubro") {
      const empresaRows = await dbGetAll(companyId, "empresa");
      const rubroNorm = normRubro(empresaRows[0] && empresaRows[0].rubro);
      const { rows } = await pool.query("SELECT tipo, valor FROM catalogos_rubro WHERE rubro_norm = $1 ORDER BY tipo, valor", [rubroNorm]);
      const porTipo = {};
      for (const r of rows) { (porTipo[r.tipo] = porTipo[r.tipo] || []).push(r.valor); }
      sendJson(res, 200, Object.entries(porTipo).map(([tipo, valores]) => ({ tipo, valores })));
      return;
    }
    if (req.method === "POST" && parts[1] === "catalogo-rubro") {
      const body = (await readBody(req)) || {};
      const tipo = String(body.tipo || "").trim();
      const valor = String(body.valor || "").trim();
      if (!tipo || !valor) { sendJson(res, 400, { error: "Debes indicar tipo y valor." }); return; }
      const empresaRows = await dbGetAll(companyId, "empresa");
      const rubroNorm = normRubro(empresaRows[0] && empresaRows[0].rubro);
      await pool.query("INSERT INTO catalogos_rubro (rubro_norm, tipo, valor) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [rubroNorm, tipo, valor]);
      sendJson(res, 200, { ok: true });
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
        delete toStore.superAdmin; // nunca escribible desde este endpoint genérico, bajo ninguna circunstancia
        if (toStore.email) {
          toStore.email = String(toStore.email).trim().toLowerCase();
          const otros = await dbGetAll(companyId, store);
          if (otros.some((u) => u.id !== body.id && u.email === toStore.email)) {
            sendJson(res, 400, { error: "Ya hay otro usuario de esta empresa con ese correo." });
            return;
          }
        }
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
