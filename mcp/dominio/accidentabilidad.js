"use strict";
// Reglas del módulo Accidentabilidad, copiadas de index.html (app
// prevencion-riesgos-app-pehuen). Cada función indica la original.

const CAT = require("./catalogos-accidentabilidad.json");
const { fallar, esFechaIso } = require("../util");

const TIPOS_ACCIDENTE = ["ctp", "stp", "trayecto", "enfermedad"]; // opciones de #accTipo
const GRAVEDADES = Object.keys(CAT.ACC_GRAVEDAD_LABEL); // leve, grave, fatal
const CRITERIOS_GRAVE = CAT.ACC_CRITERIOS_GRAVE.map((c) => c.key);
const CONDICIONES_CALZADA = Object.keys(CAT.COEF_FRICCION_REF); // + "otro" en la calzada principal
const ARBOL_TIPOS = Object.keys(CAT.ARBOL_TIPO_LABEL);
const ARBOL_PLAZOS = Object.keys(CAT.ARBOL_PLAZO_LABEL);
const TRANSITO_TIPOS = Object.keys(CAT.TRANSITO_TIPO_LABEL);
const ESTADOS_CONDUCTOR = Object.keys(CAT.TRANSITO_TIEMPO_REACCION_SUGERIDO);
const ESTADOS_CHECKLIST = ["ok", "fail", "na"]; // Cumple / No cumple / N/A
const ESTADO_CHECKLIST_LABEL = { ok: "Cumple", fail: "No cumple", na: "N/A", "": "Sin responder" };

function clasificaAplica(tipo) { return ["ctp", "stp", "trayecto"].includes(tipo); } // accClasificaAplica()
function denunciaSigla(tipo) { return tipo === "enfermedad" ? "DIEP" : (["ctp", "stp", "trayecto"].includes(tipo) ? "DIAT" : ""); } // accDenunciaSigla()
function trabajadoresDe(a) { // accTrabajadoresDe()
  if (Array.isArray(a.trabajadoresIds) && a.trabajadoresIds.length) return a.trabajadoresIds;
  if (a.trabajadorId) return [a.trabajadorId];
  return [];
}

// Avisos legales que la app muestra al clasificar (actualizarFormClasificacionAcc()).
function avisosClasificacion(tipo, gravedad) {
  const out = [];
  if (gravedad === "fatal") out.push("Accidente fatal: provoca la muerte del trabajador en forma inmediata o como consecuencia directa del accidente.");
  if (clasificaAplica(tipo) && tipo === "trayecto" && gravedad !== "leve") out.push("Los accidentes de trayecto no generan la obligación de suspensión de faenas ni de notificación inmediata a la Inspección del Trabajo y a la SEREMI de Salud.");
  if (clasificaAplica(tipo) && tipo !== "trayecto" && gravedad !== "leve") out.push("Debe suspender de inmediato los trabajos afectados y notificar de inmediato a la Inspección del Trabajo y a la SEREMI de Salud (600 42 000 22).");
  return out;
}

// Validaciones de saveAccBtn. Normaliza el registro en el lugar.
function validarAccidente(rec) {
  if (!rec.fecha || !rec.areaId) fallar("Complete al menos la fecha y el área.");
  if (!clasificaAplica(rec.tipo)) { rec.gravedad = "leve"; rec.criteriosGrave = []; }
  if (rec.gravedad !== "grave") rec.criteriosGrave = [];
  if (rec.gravedad === "grave" && !(rec.criteriosGrave || []).length) {
    fallar("Para clasificar el accidente como grave, marca al menos uno de los criterios del Compendio SUSESO (amputación, reanimación, rescate, caída de más de 1,8 m, condiciones hiperbáricas o afectación de las faenas).", { criterios: CAT.ACC_CRITERIOS_GRAVE });
  }
  const sigla = denunciaSigla(rec.tipo);
  if (!sigla) { rec.denunciaRealizada = ""; rec.fechaDenuncia = ""; }
  if (rec.denunciaRealizada !== "si") rec.fechaDenuncia = "";
  if (rec.denunciaRealizada === "si" && !rec.fechaDenuncia) fallar(`Indica la fecha en que se presentó la ${sigla}.`);
}
// Validaciones de saveIncBtn.
function validarIncidente(rec) {
  if (!rec.fecha || !rec.areaId) fallar("Complete al menos la fecha y el área.");
  if (!rec.tipoIncidente) fallar("Elige el tipo de incidente (puedes agregar tipos nuevos en Configuración → Gestionar listas desplegables).");
  rec.danioPropiedad = rec.danioPropiedad === "si" ? "si" : "no";
  if (rec.danioPropiedad !== "si") rec.descripcionDanio = "";
}

// ---------- Árbol de causas ----------
// Palabras de juicio: la app solo advierte (arbolHechoJuicioAlerta), no bloquea.
const ARBOL_PALABRAS_JUICIO = /\b(negligente|negligencia|deficiente|deficiencia|insuficiente|insuficiencia|debía|deber[íi]a|imprudente|imprudencia|irresponsable|descuidado|descuido|mal\s+hecho|incompetente)\b/i;
// Convierte los hechos del conector ({ref, antecede_a:[ref|"central"]}) al
// formato de la app ({id, precedeA:[id|"central"]}), validando que cada
// referencia exista y que no haya ciclos (en la app solo se puede apuntar a
// hechos ya creados, así que el árbol nunca tiene ciclos).
function hechosArbol(hechos, nuevoId) {
  const ids = new Map();
  hechos.forEach((h, i) => {
    const ref = String(h.ref || h.id || `h${i + 1}`);
    if (ids.has(ref)) fallar(`Hay dos hechos con la misma referencia: ${ref}.`);
    ids.set(ref, h.id || nuevoId());
  });
  const out = hechos.map((h, i) => {
    const ref = String(h.ref || h.id || `h${i + 1}`);
    const precede = (h.antecede_a && h.antecede_a.length ? h.antecede_a : ["central"]).map((r) => {
      if (r === "central") return "central";
      if (!ids.has(String(r))) fallar(`El hecho «${h.texto}» antecede a «${r}», que no existe en la lista.`);
      if (String(r) === ref) fallar(`El hecho «${h.texto}» no puede anteceder a sí mismo.`);
      return ids.get(String(r));
    });
    return { id: ids.get(ref), texto: h.texto.trim(), tipo: h.tipo, precedeA: precede, medidaCorrectiva: (h.medida_correctiva || "").trim(), medidaPreventiva: (h.medida_preventiva || "").trim(), plazo: h.plazo || "corto" };
  });
  // sin ciclos: cada cadena de "antecede a" debe terminar en el hecho central
  const porId = new Map(out.map((h) => [h.id, h]));
  const visitando = new Set(), listo = new Set();
  function recorrer(id) {
    if (listo.has(id)) return;
    if (visitando.has(id)) fallar("Los hechos forman un ciclo (A antecede a B y B antecede a A). El árbol debe terminar siempre en el hecho central.");
    visitando.add(id);
    for (const p of porId.get(id).precedeA) if (p !== "central") recorrer(p);
    visitando.delete(id); listo.add(id);
  }
  out.forEach((h) => recorrer(h.id));
  return out;
}
function avisosJuicio(textos) {
  const con = textos.filter((t) => t && ARBOL_PALABRAS_JUICIO.test(t));
  return con.length ? ["Algunos hechos contienen palabras de juicio (p. ej. «negligente», «debía»). En un árbol de causas se describen hechos objetivos, no juicios: " + con.map((t) => `«${t}»`).join(", ")] : [];
}

// ---------- Investigación de tránsito ----------
function camposFaltantesTransito(rec) { // transitoCamposFaltantes()
  const faltan = [];
  if (!rec.vehiculo) faltan.push("Vehículo(s) involucrado(s)");
  if (!rec.responsable) faltan.push("Responsable de la investigación");
  if (!rec.descripcion) faltan.push("Descripción de los hechos");
  if (!(rec.participantesIds || []).length) faltan.push("Trabajadores involucrados / testigos");
  const tieneVelocidad = (rec.velocidadConocida > 0) || (rec.huellaFrenado > 0 && rec.coefFriccion > 0);
  if (!tieneVelocidad) faltan.push("Velocidad conocida/estimada, o huella de frenado + coeficiente de fricción");
  if (!rec.velocidadMaxima) faltan.push("Velocidad máxima permitida en el tramo");
  const sinResponder = (rec.items || []).filter((it) => !it.estado).length;
  if (sinResponder > 0) faltan.push(`${sinResponder} ítem(s) de la lista de verificación sin responder`);
  if (!rec.fotoCroquis && !(rec.fotosAdicionales || []).length) faltan.push("Croquis o al menos una fotografía del lugar");
  if (!rec.conclusiones) faltan.push("Conclusiones (usa \"Generar conclusiones técnicas\" como punto de partida)");
  return faltan;
}
// Registro vacío con los mismos valores iniciales que resetTransitoForm().
function transitoVacio(id) {
  const mu = CAT.COEF_FRICCION_REF["asfalto-seco"].mu;
  return {
    id, fecha: "", hora: "", areaId: "", accidenteId: null, tipoAccidente: "colision-frontal", vehiculo: "", responsable: "", descripcion: "",
    participantesIds: [], condicionCalzada: "asfalto-seco", coefFriccion: mu, tipoPendiente: "plana", pendientePct: 0, velocidadMaxima: null,
    estadoConductor: "normal", velocidadConocida: null, huellaFrenado: null, tiempoReaccion: 1, distanciaDisponible: null, distanciaRetroceso: null,
    condicionPostImpacto: "asfalto-seco", coefFriccionPostImpacto: mu, trocha: null, alturaCg: null, masaA: null, masaB: null, desplazamientoB: null,
    condicionB: "asfalto-seco", coefFriccionB: mu, items: CAT.TRANSITO_CHECKLIST_ITEMS.map((texto) => ({ texto, estado: "" })),
    fotoCroquis: null, iconosCroquis: {}, fotosAdicionales: [], observaciones: "", conclusiones: "",
  };
}
// Física de la app (calcVelocidadDesdeHuella / calcDistancias), solo para
// mostrar el resultado; el registro guarda los datos de entrada, como la app.
function velocidadDesdeHuella({ huellaFrenado, coefFriccion, tipoPendiente, pendientePct }) {
  const d = Number(huellaFrenado), mu = Number(coefFriccion);
  if (!(d > 0) || !(mu > 0)) return null;
  const e = (Number(pendientePct) || 0) / 100;
  const factor = tipoPendiente === "subida" ? (mu + e) : tipoPendiente === "bajada" ? Math.max(0.01, mu - e) : mu;
  if (factor <= 0) return null;
  return Math.sqrt(2 * 9.81 * d * factor);
}
function resumenCalculoTransito(rec) {
  const vHuella = velocidadDesdeHuella(rec);
  const kmh = rec.velocidadConocida > 0 ? rec.velocidadConocida : (vHuella ? vHuella * 3.6 : null);
  if (!kmh) return null;
  const v = kmh / 3.6, mu = Number(rec.coefFriccion), t = Number(rec.tiempoReaccion) || 0;
  const distReaccion = v * t, distFrenado = mu > 0 ? (v * v) / (2 * 9.81 * mu) : null;
  const r = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return {
    velocidadKmh: r(kmh), origen: rec.velocidadConocida > 0 ? "velocidad conocida/estimada" : "huella de frenado",
    velocidadMaximaKmh: rec.velocidadMaxima || null,
    excesoKmh: rec.velocidadMaxima ? r(kmh - rec.velocidadMaxima) : null,
    distanciaReaccionM: r(distReaccion), distanciaFrenadoM: r(distFrenado), distanciaDetencionM: distFrenado == null ? null : r(distReaccion + distFrenado),
    nota: "Cálculo orientativo con la misma física de la app (V=√(2·g·μ·d), d=V·t + V²/(2·g·μ)). La app muestra el análisis completo en la investigación.",
  };
}

// Fotos (data URL de imagen) para fotosAdicionales: mismo formato que la app.
const FOTO_MAX_BYTES = 1.5 * 1024 * 1024;
const FOTOS_MAX_POR_LLAMADA = 6;
const FOTOS_MAX_TOTAL = 20;
function validarFoto(dataUrl, i) {
  const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) fallar(`La foto ${i + 1} debe ser una imagen JPG, PNG o WEBP en formato data URL (data:image/jpeg;base64,...).`);
  const bytes = Math.floor(m[3].length * 3 / 4);
  if (bytes > FOTO_MAX_BYTES) fallar(`La foto ${i + 1} pesa ${(bytes / 1048576).toFixed(1)} MB; el máximo es 1,5 MB. Redúcela antes de adjuntarla.`);
  return dataUrl;
}

function esFechaValida(s) { return esFechaIso(s); }

module.exports = {
  CAT, TIPOS_ACCIDENTE, GRAVEDADES, CRITERIOS_GRAVE, CONDICIONES_CALZADA, ARBOL_TIPOS, ARBOL_PLAZOS, TRANSITO_TIPOS, ESTADOS_CONDUCTOR,
  ESTADOS_CHECKLIST, ESTADO_CHECKLIST_LABEL, clasificaAplica, denunciaSigla, trabajadoresDe, avisosClasificacion, validarAccidente, validarIncidente,
  ARBOL_PALABRAS_JUICIO, hechosArbol, avisosJuicio, camposFaltantesTransito, transitoVacio, velocidadDesdeHuella, resumenCalculoTransito,
  FOTO_MAX_BYTES, FOTOS_MAX_POR_LLAMADA, FOTOS_MAX_TOTAL, validarFoto, esFechaValida,
};
