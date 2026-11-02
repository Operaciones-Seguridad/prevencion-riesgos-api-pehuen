"use strict";
// Reglas de Programa de seguridad, Capacitación, Control documental y
// Trabajadores, copiadas de index.html (app prevencion-riesgos-app-pehuen).

const { hoyIso, diasHasta, pcNorm, normEspacios, sumarMeses, soloFecha, uid } = require("../util");
const CAT = require("./catalogos-app.json");

// ===================== Programa de seguridad =====================
const PG_TIPOS = { capacitacion: "Capacitación", inspeccion: "Inspección", simulacro: "Simulacro / emergencia", difusion: "Difusión de protocolos", comite: "Comité paritario", otro: "Otro" };
function estadoPrograma(p, hoy = hoyIso()) { // estadoPrograma()
  if (p.fechaRealizada) return "realizada";
  if (p.fechaProgramada && diasHasta(p.fechaProgramada, hoy) < 0) return "atrasada";
  return "pendiente";
}
// pcPersonaPorNombre(): el responsable debe ser una "Persona del programa".
function personaPorNombre(nombre, personas) {
  const n = pcNorm(String(nombre || "").trim());
  return n ? ((personas || []).find((x) => pcNorm(x.nombre) === n) || null) : null;
}
function pcSem4(a) { const r = [0, 0, 0, 0]; if (Array.isArray(a)) for (let i = 0; i < 4; i++) { const n = parseInt(a[i], 10); r[i] = isNaN(n) || n < 0 ? 0 : n; } return r; }
function pcFuente(a) {
  const LABEL = ["manual", "inspeccion", "observacion", "comite", "capacitacion", "programa"];
  const f = a && a.fuente; return f && f.tipo && LABEL.includes(f.tipo) ? f : { tipo: "manual" };
}
// pcAsegurarHojaDe(): crea la hoja mensual (programaCargo) del responsable
// si todavía no existe, aplicando la planificación de su cargo si la hay.
// Devuelve el registro a crear, o null si no corresponde.
function hojaMensualACrear(actividad, personas, hojas, plantillas) {
  const per = personaPorNombre(actividad.responsable !== undefined ? actividad.responsable : actividad.relator, personas);
  const m = /^(\d{4})-(\d{2})/.exec(actividad.fechaProgramada || "");
  if (!per || !m) return null;
  const anio = +m[1], mes = +m[2];
  const n = pcNorm(per.nombre);
  if ((hojas || []).some((p) => p.anio === anio && p.mes === mes && (p.personaId === per.id || pcNorm(p.nombre) === n))) return null;
  const rec = { id: uid(), anio, mes, cargo: per.cargo || "", nombre: per.nombre, personaId: per.id, trabajadorId: per.trabajadorId || "", focoCritico: "", actividades: [], observaciones: "" };
  // pcBuscarPlan(anio, mes, cargo) con mes 1..12
  const pl = (plantillas || []).find((p) => (p.mes || 0) === mes && p.anio === anio && pcNorm(p.cargo) === pcNorm(per.cargo));
  if (pl) aplicarPlanAHoja(pl, rec);
  return rec;
}
function aplicarPlanAHoja(plan, hoja) { // pcAplicarPlanAHoja()
  hoja.cargo = plan.cargo || hoja.cargo;
  if (plan.focoCritico) hoja.focoCritico = plan.focoCritico;
  const ids = new Set((plan.actividades || []).map((a) => a.id));
  (plan.actividades || []).forEach((pa) => {
    const ha = (hoja.actividades || []).find((x) => x.planActId === pa.id);
    if (ha) { ha.nombre = pa.nombre; ha.proy = pcSem4(pa.proy); ha.fuente = Object.assign({}, pcFuente(pa)); }
    else (hoja.actividades = hoja.actividades || []).push({ id: uid(), planActId: pa.id, nombre: pa.nombre, proy: pcSem4(pa.proy), real: [0, 0, 0, 0], fuente: Object.assign({}, pcFuente(pa)) });
  });
  hoja.actividades = (hoja.actividades || []).filter((x) => !x.planActId || ids.has(x.planActId) || pcSem4(x.real).some((v) => v > 0));
}
// renderProgramaCumplimientoPorResponsable(): % realizadas / programadas.
function avancePrograma(actividades) {
  const total = { programadas: 0, realizadas: 0, atrasadas: 0, pendientes: 0 };
  const porResp = new Map();
  for (const p of actividades) {
    const resp = (p.responsable || "").trim() || "(sin responsable asignado)";
    if (!porResp.has(resp)) porResp.set(resp, { responsable: resp, programadas: 0, realizadas: 0, atrasadas: 0 });
    const st = porResp.get(resp);
    const e = estadoPrograma(p);
    st.programadas++; total.programadas++;
    if (e === "realizada") { st.realizadas++; total.realizadas++; }
    else if (e === "atrasada") { st.atrasadas++; total.atrasadas++; }
    else total.pendientes++;
  }
  const pct = (r, t) => (t ? Math.round((r / t) * 100) : 0);
  const semaforo = (x) => (x >= 80 ? "verde (≥80%)" : x >= 50 ? "amarillo (50–79%)" : "rojo (<50%)");
  const porResponsable = [...porResp.values()].sort((a, b) => b.programadas - a.programadas)
    .map((s) => Object.assign(s, { porcentaje: pct(s.realizadas, s.programadas), semaforo: semaforo(pct(s.realizadas, s.programadas)) }));
  const p = pct(total.realizadas, total.programadas);
  return { total: Object.assign(total, { porcentaje: p, semaforo: semaforo(p) }), porResponsable };
}

// ===================== Capacitación =====================
function estadoCapacitacion(c, hoy = hoyIso()) { // estadoCapacitacion()
  if (c.fechaRealizada) return "realizada";
  if (c.fechaProgramada && diasHasta(c.fechaProgramada, hoy) < 0) return "atrasada";
  return "pendiente";
}
function cumplimientoCapacitacion(c) { // capacitacionCumplimiento()
  const ps = c.participantes || [];
  const asistieron = ps.filter((p) => p.asistio).length;
  return { convocados: ps.length, asistieron, aprobados: ps.filter((p) => p.aprobado).length, porcentaje: ps.length ? Math.round((asistieron / ps.length) * 100) : 0 };
}
function convocadosDe(d, trabajadores) { // capConvocadosDe()
  if (d.tipo === "todos") return trabajadores.map((t) => t.id);
  if (d.tipo === "cargos") { const cs = new Set((d.cargos || []).map(pcNorm)); return trabajadores.filter((t) => t.cargo && cs.has(pcNorm(t.cargo))).map((t) => t.id); }
  if (d.tipo === "personas") return (d.personasIds || []).filter((id) => trabajadores.some((t) => t.id === id));
  return [];
}
function sincronizarParticipantes(rec, d, trabajadores) { // capSincronizarParticipantes()
  if (d.tipo === "ninguno") return;
  const objetivo = new Set(convocadosDe(d, trabajadores));
  const nuevos = (rec.participantes || []).filter((p) => p.asistio || objetivo.has(p.trabajadorId));
  objetivo.forEach((id) => { if (!nuevos.some((p) => p.trabajadorId === id)) nuevos.push({ trabajadorId: id, asistio: false, aprobado: false }); });
  rec.participantes = nuevos;
}
function actualizarRealizada(rec, hoy = hoyIso()) { // capActualizarRealizada()
  const hay = (rec.participantes || []).some((p) => p.asistio);
  if (hay && !rec.fechaRealizada) {
    rec.fechaRealizada = rec.fechaProgramada && rec.fechaProgramada <= hoy ? rec.fechaProgramada : hoy;
    rec.realizadaAuto = true;
  } else if (!hay && rec.fechaRealizada && rec.realizadaAuto) {
    rec.fechaRealizada = null; rec.realizadaAuto = false;
  }
}
function tiposCapacitacion(rubro, extra) { // getCatalog("capTipo")
  const base = CAT.CATALOG_BASE.capTipo;
  const r = (rubro || []).filter((v) => !base.includes(v));
  const e = (extra || []).filter((v) => !base.includes(v) && !r.includes(v));
  return base.concat(r).concat(e);
}
// Cursos obligatorios: tramoMinimoAplica / cursoAplicaATrabajador / ultimoCursoDe / estadoVencimientoCurso
function tramoMinimoAplica(t, n) {
  n = n || 0;
  if (t === "10-25-sin-comite") return n >= 10 && n <= 25;
  if (t === "mas-25") return n > 25;
  if (t === "mas-100") return n > 100;
  return true;
}
function cursoAplica(curso, trabajador, n) {
  if (!tramoMinimoAplica(curso.tramoMinimo, n)) return false;
  if ((curso.aplicaA || []).includes("todos")) return true;
  return (curso.aplicaA || []).some((r) => (trabajador.roles || []).includes(r));
}
function ultimoCurso(trabajadorId, cursoId, registros) {
  const regs = registros.filter((r) => r.trabajadorId === trabajadorId && r.cursoId === cursoId);
  if (!regs.length) return null;
  return regs.slice().sort((a, b) => String(soloFecha(b.fechaAprobacion) || "").localeCompare(String(soloFecha(a.fechaAprobacion) || "")))[0];
}
function estadoVencimientoCurso(reg, hoy = hoyIso(), diasAviso = 60) {
  if (!reg) return "nunca";
  if (!reg.fechaVencimiento) return "vigente";
  const d = diasHasta(reg.fechaVencimiento, hoy);
  if (d < 0) return "vencido";
  if (d <= diasAviso) return "proximo";
  return "vigente";
}
const CURSO_ESTADO_LABEL = { vencido: "Vencido", proximo: "Próximo a vencer", vigente: "Vigente", nunca: "Nunca completado" };
function fechaVencimientoCurso(curso, fechaAprobacion) {
  return curso && curso.vigenciaAnios ? sumarMeses(fechaAprobacion, curso.vigenciaAnios * 12) : null;
}

// ===================== Control documental =====================
const DOC_TIPOS = { politica: "Política de Seguridad y Salud en el Trabajo", procedimiento: "Procedimiento", manual: "Manual", matriz: "Matriz de riesgos (documento formal)", otro: "Otro documento" };
const DOC_SUBTIPOS = { procedimiento: "Procedimiento de trabajo seguro", instructivo: "Instructivo de trabajo" };
function documentoKey(d) { return (d.tipo || "") + "||" + normEspacios(d.nombre); }
function fechaVigenciaDoc(d) { return soloFecha(d.fechaActualizacion || d.fechaConfeccion) || ""; }
function documentosVigentesMap(docs) { // documentosVigentesMap()
  const map = new Map();
  docs.forEach((d) => {
    const k = documentoKey(d), cur = map.get(k);
    if (!cur || fechaVigenciaDoc(d) > fechaVigenciaDoc(cur)) map.set(k, d);
  });
  return map;
}
// Definición aprobada por Carlos (no existe en la app): la versión vigente
// está vencida si su fecha de revisión ya pasó; si no tiene fecha de
// revisión, si pasaron más de 12 meses desde su actualización/confección.
function vencimientoDocumento(d, hoy = hoyIso()) {
  if (d.fechaRevision) {
    const dias = diasHasta(d.fechaRevision, hoy);
    return { criterio: "fecha de revisión", fechaLimite: soloFecha(d.fechaRevision), dias, vencido: dias < 0 };
  }
  const base = fechaVigenciaDoc(d);
  if (!base) return { criterio: "sin fechas registradas", fechaLimite: null, dias: null, vencido: false, sinFechas: true };
  const limite = sumarMeses(base, 12);
  const dias = diasHasta(limite, hoy);
  return { criterio: "12 meses desde la actualización", fechaLimite: limite, dias, vencido: dias < 0 };
}

// ===================== Trabajadores =====================
const ROLES_TRABAJADOR = { comite_paritario: "Comité paritario", delegado: "Delegado SST", prevencionista: "Prevencionista" };

module.exports = {
  PG_TIPOS, estadoPrograma, personaPorNombre, hojaMensualACrear, aplicarPlanAHoja, avancePrograma,
  estadoCapacitacion, cumplimientoCapacitacion, convocadosDe, sincronizarParticipantes, actualizarRealizada, tiposCapacitacion,
  tramoMinimoAplica, cursoAplica, ultimoCurso, estadoVencimientoCurso, CURSO_ESTADO_LABEL, fechaVencimientoCurso,
  DOC_TIPOS, DOC_SUBTIPOS, documentoKey, documentosVigentesMap, vencimientoDocumento, fechaVigenciaDoc,
  ROLES_TRABAJADOR,
};
