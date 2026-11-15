"use strict";
// Utilidades compartidas por el conector MCP: fechas, normalización de
// texto, ids, limpieza de adjuntos y un validador mínimo de argumentos
// (subconjunto de JSON Schema) para no agregar dependencias.

const crypto = require("crypto");

// Zona horaria de referencia para "hoy": la app se usa en Chile y compara
// fechas AAAA-MM-DD guardadas desde <input type=date> como fechas locales.
const ZONA = process.env.MCP_ZONA_HORARIA || "America/Santiago";

function hoyIso(ahora = new Date()) {
  // en-CA formatea como AAAA-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
}
function esFechaIso(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
// Toma solo la parte AAAA-MM-DD de un valor de fecha guardado (la app a
// veces guarda ISO completo, p. ej. fechaVencimiento de trabajadorCursos).
function soloFecha(v) {
  if (!v) return null;
  if (v instanceof Date) return hoyIso(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d) ? null : hoyIso(d);
}
function diasHasta(fecha, hoy = hoyIso()) {
  const f = soloFecha(fecha);
  if (!f) return null;
  const a = Date.UTC(...f.split("-").map((x, i) => (i === 1 ? +x - 1 : +x)));
  const b = Date.UTC(...hoy.split("-").map((x, i) => (i === 1 ? +x - 1 : +x)));
  return Math.round((a - b) / 86400000);
}
function sumarMeses(fecha, meses) {
  const [a, m, d] = soloFecha(fecha).split("-").map(Number);
  // mismo comportamiento que Date.setMonth de la app (desborda al mes siguiente)
  const dt = new Date(Date.UTC(a, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + meses);
  return dt.toISOString().slice(0, 10);
}

// Mismo formato de id que uid() de la app.
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Normalizaciones idénticas a las de la app.
function matrizNorm(t) { return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim(); }
function normalizarNombreTexto(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim(); }
const pcNorm = normalizarNombreTexto;
function normEspacios(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }

// Reemplaza adjuntos en base64 (data URLs) por un marcador, para no
// devolver megabytes a Claude ni guardarlos en la auditoría.
function esAdjunto(v) { return typeof v === "string" && v.length > 200 && /^data:[^;,]+(;[^,]*)?,/.test(v); }
function omitirAdjuntos(valor, modo = "salida") {
  // Las fechas (p. ej. "momento" de la auditoría, que pg entrega como Date)
  // se devuelven en ISO; si no, Object.entries las dejaría como {}.
  if (valor instanceof Date) return isNaN(valor) ? null : valor.toISOString();
  if (Array.isArray(valor)) return valor.map((x) => omitirAdjuntos(x, modo));
  if (valor && typeof valor === "object") {
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = omitirAdjuntos(v, modo);
    return out;
  }
  if (esAdjunto(valor)) {
    if (modo === "auditoria") {
      return { adjuntoOmitido: true, bytes: valor.length, sha256: crypto.createHash("sha256").update(valor).digest("hex") };
    }
    return "[archivo adjunto: no se muestra por el conector]";
  }
  return valor;
}

class ErrorHerramienta extends Error {
  constructor(mensaje, detalle) { super(mensaje); this.detalle = detalle; }
}
function fallar(mensaje, detalle) { throw new ErrorHerramienta(mensaje, detalle); }

// ---------- validador mínimo de argumentos (subconjunto de JSON Schema) ----------
function validarEsquema(schema, valor, ruta = "argumentos") {
  const errores = [];
  const tipoDe = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  function ok(s, v, r) {
    if (s.type) {
      const tipos = Array.isArray(s.type) ? s.type : [s.type];
      const t = tipoDe(v);
      const calza = tipos.some((x) => x === t || (x === "number" && (t === "integer" || t === "number")));
      if (!calza) { errores.push(`${r}: debe ser ${tipos.join(" o ")}`); return; }
    }
    if (s.enum && !s.enum.includes(v)) { errores.push(`${r}: valor no permitido (${JSON.stringify(v)}). Opciones: ${s.enum.join(", ")}`); return; }
    if (typeof v === "string") {
      if (s.minLength && v.trim().length < s.minLength) errores.push(`${r}: no puede estar vacío`);
      if (s.maxLength && v.length > s.maxLength) errores.push(`${r}: máximo ${s.maxLength} caracteres`);
      if (s.format === "date" && !esFechaIso(v)) errores.push(`${r}: debe ser una fecha AAAA-MM-DD válida`);
    }
    if (typeof v === "number") {
      if (s.minimum !== undefined && v < s.minimum) errores.push(`${r}: mínimo ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errores.push(`${r}: máximo ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems && v.length < s.minItems) errores.push(`${r}: debe tener al menos ${s.minItems} elemento(s)`);
      if (s.maxItems && v.length > s.maxItems) errores.push(`${r}: máximo ${s.maxItems} elementos`);
      if (s.items) v.forEach((x, i) => ok(s.items, x, `${r}[${i}]`));
    }
    if (v && typeof v === "object" && !Array.isArray(v) && s.properties) {
      for (const req of s.required || []) if (v[req] === undefined) errores.push(`${r}.${req}: es obligatorio`);
      for (const [k, x] of Object.entries(v)) {
        if (s.properties[k]) { if (x !== undefined) ok(s.properties[k], x, `${r}.${k}`); }
        else if (s.additionalProperties === false) errores.push(`${r}.${k}: campo desconocido`);
      }
    }
  }
  ok(schema, valor, ruta);
  return errores;
}

function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function tokenAleatorio(prefijo, bytes = 32) { return prefijo + crypto.randomBytes(bytes).toString("base64url"); }

module.exports = {
  ZONA, hoyIso, esFechaIso, soloFecha, diasHasta, sumarMeses, uid,
  matrizNorm, normalizarNombreTexto, pcNorm, normEspacios,
  esAdjunto, omitirAdjuntos, ErrorHerramienta, fallar, validarEsquema, sha256, tokenAleatorio,
};
