"use strict";
// Reglas de la Matriz de riesgos (MIPER) y su Plan de acción, copiadas de
// index.html (app prevencion-riesgos-app-pehuen). Cada función indica la
// función original; si la app cambia una regla, hay que cambiarla aquí.

const CAT = require("./catalogos-app.json");
const { hoyIso, matrizNorm, normEspacios, diasHasta } = require("../util");

// MATRIZ_NIVEL_TABLA: fila = probabilidad, columna = consecuencia.
const MATRIZ_NIVEL_TABLA = {
  5: { 1: "medio", 2: "medio", 3: "alto", 4: "critico", 5: "critico" },
  4: { 1: "medio", 2: "medio", 3: "alto", 4: "alto", 5: "critico" },
  3: { 1: "bajo", 2: "medio", 3: "medio", 4: "alto", 5: "critico" },
  2: { 1: "bajo", 2: "medio", 3: "medio", 4: "medio", 5: "critico" },
  1: { 1: "bajo", 2: "bajo", 3: "medio", 4: "medio", 5: "critico" },
};
const NIVEL_LABEL = { bajo: "Bajo", medio: "Medio", alto: "Alto", critico: "Muy alto" };
const NIVEL_RANGO = { bajo: 0, medio: 1, alto: 2, critico: 3 };
const NIVELES = ["bajo", "medio", "alto", "critico"];

function nivelRiesgo(p, c) { // nivelRiesgo()
  const fila = MATRIZ_NIVEL_TABLA[Math.round(+p)];
  return (fila && fila[Math.round(+c)]) || "bajo";
}
function nivelLabel(n) { return NIVEL_LABEL[n] || n; }
function valorOrdenRiesgoPC(p, c) { return (NIVEL_RANGO[nivelRiesgo(p, c)] || 0) * 100 + (+p || 0) * (+c || 0); }
function tieneResidualEvaluado(m) { return !!(m && m.probabilidadResidual && m.consecuenciaResidual); }
function probResidualEfectiva(m) { return (m && m.probabilidadResidual) || (m && m.probabilidad); }
function consResidualEfectiva(m) { return (m && m.consecuenciaResidual) || (m && m.consecuencia); }
function nivelRiesgoLinea(m) { return nivelRiesgo(probResidualEfectiva(m), consResidualEfectiva(m)); }
function nivelPuroLinea(m) { return nivelRiesgo(m.probabilidad, m.consecuencia); }

// parseControlesBullets(): líneas antiguas con controles en texto libre.
function parseControlesBullets(controlesTxt, responsableTxt) {
  const partir = (t) => String(t || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const re = /^[•\-\*]?\s*([A-E])\)\s*(.*)$/i;
  const c = partir(controlesTxt), r = partir(responsableTxt);
  return c.map((linea, i) => {
    const m = linea.match(re);
    let responsable = "";
    if (r[i]) { const rm = r[i].match(re); responsable = rm ? rm[2].trim() : r[i]; }
    return { jerarquia: m ? m[1].toUpperCase() : "", texto: m ? m[2].trim() : linea, responsable, plazo: "" };
  });
}
function jerarquiaDe(m) { // jerarquiaDe()
  if (Array.isArray(m.controlesJerarquizados) && m.controlesJerarquizados.length) return m.controlesJerarquizados;
  return parseControlesBullets(m.controles, m.responsable);
}
function controlesTextoPlano(items) { return (items || []).map((c) => `• ${c.jerarquia || "?"}) ${c.texto}`).join("\n"); }
function responsableTextoPlano(items) { return (items || []).filter((c) => c.responsable).map((c) => `• ${c.jerarquia || "?"}) ${c.responsable}`).join("\n"); }
function plazoResumenControles(items) { const f = (items || []).map((c) => c.plazo).filter(Boolean).sort(); return f.length ? f[0] : ""; }
function matrizLineLabel(m) { return `${m.proceso ? m.proceso + " / " : ""}${m.actividad || "—"} — ${m.peligro || ""}`; }

// ---------- Plan de acción (paXxx en la app) ----------
function accionesDe(m, plan) { return (plan || []).filter((p) => p.matrizId === m.id); }
function accionesAbiertas(m, plan) { return accionesDe(m, plan).filter((p) => p.estado !== "cumplida"); }
function tieneControles(m) { const it = jerarquiaDe(m); return !!(it && it.length) || !!(m.controles && String(m.controles).trim()); }
function aceptacionVigente(m, hoy = hoyIso()) { const a = m.aceptacionRiesgo; return a && !a.revocada && (!a.revisarEn || a.revisarEn >= hoy) ? a : null; }
function aceptacionVencida(m, hoy = hoyIso()) { const a = m.aceptacionRiesgo; return !!(a && !a.revocada && a.revisarEn && a.revisarEn < hoy); }
function residualPorEvaluar(m, plan, hoy) {
  return nivelRiesgoLinea(m) !== "bajo" && !tieneResidualEvaluado(m) && tieneControles(m) && !accionesAbiertas(m, plan).length && !aceptacionVigente(m, hoy);
}
function requiereAccion(m, plan, hoy) {
  return nivelRiesgoLinea(m) !== "bajo" && !residualPorEvaluar(m, plan, hoy) && !accionesAbiertas(m, plan).length && !aceptacionVigente(m, hoy);
}
function estadoTratamiento(m, plan, hoy) { // paEstadoTratamiento()
  if (accionesAbiertas(m, plan).length) return { k: "tratamiento", label: "En tratamiento" };
  if (nivelRiesgoLinea(m) === "bajo") return { k: "controlado", label: "Controlado" };
  if (aceptacionVigente(m, hoy)) return { k: "aceptado", label: "Medio aceptado" };
  if (residualPorEvaluar(m, plan, hoy)) return { k: "por_evaluar", label: "Por evaluar residual" };
  return { k: "requiere", label: "Requiere más medidas" };
}
const ESTADOS_TRATAMIENTO = ["tratamiento", "controlado", "aceptado", "por_evaluar", "requiere"];
function estadoAccionMostrado(p, hoy = hoyIso()) { // paEstadoMostrado()
  if (p.estado === "cumplida") return "cumplida";
  if (p.plazo && p.plazo < hoy) return "atrasada";
  return p.estado || "pendiente";
}
const PA_TIPO_LABEL = { mitigar: "Mitigar", evitar: "Evitar", transferir: "Transferir", aceptar: "Aceptar" };
const PA_TIPOS = Object.keys(PA_TIPO_LABEL);
const PA_ESTADOS_GUARDADOS = ["pendiente", "proceso", "cumplida"];

// Perfil que puede aceptar riesgos Medio (paPuedeAceptarRiesgos()).
function puedeAceptarRiesgos(perfil) {
  if (!perfil) return false;
  if (perfil.puedeAceptarRiesgos !== undefined) return !!perfil.puedeAceptarRiesgos;
  return /prevencion/.test(matrizNorm(perfil.nombre || ""));
}

// ---------- símbolos oficiales (ANEXO1_SIMBOLOS) ----------
const SIMBOLOS = CAT.ANEXO1_SIMBOLOS;
function simboloPorId(id) { return SIMBOLOS.find((r) => r.id === id) || null; }
const JERARQUIAS = CAT.JERARQUIA_DS44.map((j) => j.code);
const GRUPOS_SENSIBLES = [
  "Embarazada o en período de lactancia", "Adolescente (menor de 18 años)", "Persona en situación de discapacidad",
  "Persona migrante", "Adulto mayor", "Trabajo nocturno / turno de noche",
];

// Vincula una medida D) a un procedimiento registrado con el mismo nombre
// (mismo criterio que addControlBtn en la app).
function documentoCoincidente(texto, documentos) {
  const d = (documentos || []).find((x) => x.tipo === "procedimiento" && normEspacios(x.nombre) === normEspacios(texto));
  return d ? d.id : null;
}

// Resumen de una línea para respuestas del conector.
function resumenLinea(m, plan, areasPorId, hoy) {
  const t = estadoTratamiento(m, plan, hoy);
  const nr = nivelRiesgoLinea(m);
  return {
    id: m.id, area: (areasPorId[m.areaId] || {}).nombre || "—", areaId: m.areaId,
    proceso: m.proceso || "", actividad: m.actividad || "", categoria: m.categoria || "",
    peligro: m.peligro || "", riesgo: m.riesgo || "",
    nivelPuro: nivelLabel(nivelPuroLinea(m)), pc: `${m.probabilidad || "?"} x ${m.consecuencia || "?"}`,
    nivelResidual: tieneResidualEvaluado(m) ? nivelLabel(nr) : null,
    pcResidual: tieneResidualEvaluado(m) ? `${m.probabilidadResidual} x ${m.consecuenciaResidual}` : null,
    nivelEfectivo: nivelLabel(nr), nivelEfectivoClave: nr,
    estadoTratamiento: t.label, estadoTratamientoClave: t.k,
    controles: jerarquiaDe(m).length, accionesAbiertas: accionesAbiertas(m, plan).length,
    sensible: !!m.sensible,
    _version: m._version,
  };
}

function diasParaRevisionAceptacion(m, hoy) { return m.aceptacionRiesgo && m.aceptacionRiesgo.revisarEn ? diasHasta(m.aceptacionRiesgo.revisarEn, hoy) : null; }

module.exports = {
  MATRIZ_NIVEL_TABLA, NIVELES, NIVEL_LABEL, nivelRiesgo, nivelLabel, valorOrdenRiesgoPC,
  tieneResidualEvaluado, probResidualEfectiva, consResidualEfectiva, nivelRiesgoLinea, nivelPuroLinea,
  parseControlesBullets, jerarquiaDe, controlesTextoPlano, responsableTextoPlano, plazoResumenControles, matrizLineLabel,
  accionesDe, accionesAbiertas, tieneControles, aceptacionVigente, aceptacionVencida, residualPorEvaluar, requiereAccion,
  estadoTratamiento, ESTADOS_TRATAMIENTO, estadoAccionMostrado, PA_TIPO_LABEL, PA_TIPOS, PA_ESTADOS_GUARDADOS,
  puedeAceptarRiesgos, SIMBOLOS, simboloPorId, JERARQUIAS, GRUPOS_SENSIBLES, documentoCoincidente, resumenLinea,
  diasParaRevisionAceptacion,
};
