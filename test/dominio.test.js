"use strict";
// Pruebas unitarias de las reglas copiadas de la app (sin base de datos).
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../mcp/dominio/miper");
const O = require("../mcp/dominio/otros");
const U = require("../mcp/util");

test("tabla de nivel de riesgo: las 25 combinaciones calzan con MATRIZ_NIVEL_TABLA de la app", () => {
  const esperado = [ // fila = probabilidad 1..5, columna = consecuencia 1..5
    ["bajo", "bajo", "medio", "medio", "critico"],
    ["bajo", "medio", "medio", "medio", "critico"],
    ["bajo", "medio", "medio", "alto", "critico"],
    ["medio", "medio", "alto", "alto", "critico"],
    ["medio", "medio", "alto", "critico", "critico"],
  ];
  for (let p = 1; p <= 5; p++) for (let c = 1; c <= 5; c++) assert.equal(D.nivelRiesgo(p, c), esperado[p - 1][c - 1], `P${p} x C${c}`);
  assert.equal(D.nivelRiesgo(0, 0), "bajo");
  assert.equal(D.nivelLabel("critico"), "Muy alto");
});

test("riesgo efectivo usa el residual solo si está evaluado", () => {
  const m = { probabilidad: 4, consecuencia: 4 };
  assert.equal(D.nivelRiesgoLinea(m), "alto");
  assert.equal(D.tieneResidualEvaluado(m), false);
  assert.equal(D.nivelRiesgoLinea(Object.assign({ probabilidadResidual: 2, consecuenciaResidual: 2 }, m)), "medio");
  assert.equal(D.nivelRiesgoLinea(Object.assign({ probabilidadResidual: 1 }, m)), "medio"); // P1 x C4 (cons. pura)
});

test("orden de riesgo: el nivel manda sobre el producto P x C", () => {
  assert.ok(D.valorOrdenRiesgoPC(1, 5) > D.valorOrdenRiesgoPC(4, 4)); // Muy alto (5) > Alto (16)
});

test("controles: texto heredado se interpreta igual que parseControlesBullets", () => {
  const m = { controles: "• C) Guarda fija\n• E) Careta", responsable: "• C) Juan" };
  assert.deepEqual(D.jerarquiaDe(m), [{ jerarquia: "C", texto: "Guarda fija", responsable: "Juan", plazo: "" }, { jerarquia: "E", texto: "Careta", responsable: "", plazo: "" }]);
  const items = [{ jerarquia: "D", texto: "Procedimiento", responsable: "Ana", plazo: "2026-12-01" }, { jerarquia: "E", texto: "EPP", responsable: "", plazo: "2026-11-15" }];
  assert.equal(D.controlesTextoPlano(items), "• D) Procedimiento\n• E) EPP");
  assert.equal(D.responsableTextoPlano(items), "• D) Ana");
  assert.equal(D.plazoResumenControles(items), "2026-11-15");
});

test("plan de acción: estados de tratamiento y requerimiento de acción", () => {
  const hoy = "2026-11-02";
  const conControles = { id: "a", probabilidad: 3, consecuencia: 3, controlesJerarquizados: [{ jerarquia: "D", texto: "x" }] };
  assert.equal(D.estadoTratamiento(conControles, [], hoy).k, "por_evaluar");
  assert.equal(D.requiereAccion(conControles, [], hoy), false);
  const sinControles = { id: "b", probabilidad: 3, consecuencia: 3 };
  assert.equal(D.estadoTratamiento(sinControles, [], hoy).k, "requiere");
  assert.equal(D.estadoTratamiento(sinControles, [{ matrizId: "b", estado: "pendiente" }], hoy).k, "tratamiento");
  const aceptada = Object.assign({ aceptacionRiesgo: { revocada: false, revisarEn: "2026-12-01" } }, sinControles);
  assert.equal(D.estadoTratamiento(aceptada, [], hoy).k, "aceptado");
  assert.equal(D.aceptacionVencida(Object.assign({}, aceptada, { aceptacionRiesgo: { revocada: false, revisarEn: "2026-11-01" } }), hoy), true);
  assert.equal(D.estadoTratamiento({ id: "c", probabilidad: 1, consecuencia: 1 }, [], hoy).k, "controlado");
});

test("plan de acción: 'atrasada' es derivado (plazo vencido y no cumplida)", () => {
  assert.equal(D.estadoAccionMostrado({ estado: "pendiente", plazo: "2026-11-01" }, "2026-11-02"), "atrasada");
  assert.equal(D.estadoAccionMostrado({ estado: "cumplida", plazo: "2026-01-01" }, "2026-11-02"), "cumplida");
  assert.equal(D.estadoAccionMostrado({ estado: "proceso", plazo: "2026-12-01" }, "2026-11-02"), "proceso");
});

test("permiso para aceptar riesgos: explícito o por nombre de perfil «prevención»", () => {
  assert.equal(D.puedeAceptarRiesgos({ nombre: "Supervisor" }), false);
  assert.equal(D.puedeAceptarRiesgos({ nombre: "Prevencionista de Riesgos" }), true);
  assert.equal(D.puedeAceptarRiesgos({ nombre: "Prevencionista", puedeAceptarRiesgos: false }), false);
  assert.equal(D.puedeAceptarRiesgos({ nombre: "Gerencia", puedeAceptarRiesgos: true }), true);
  assert.equal(D.puedeAceptarRiesgos(null), false);
});

test("programa: estados y avance (% realizadas sobre programadas)", () => {
  const hoy = U.hoyIso();
  const ayer = U.sumarMeses(hoy, -1);
  const acts = [{ responsable: "A", fechaProgramada: ayer, fechaRealizada: ayer }, { responsable: "A", fechaProgramada: ayer, fechaRealizada: null }, { responsable: "B", fechaProgramada: U.sumarMeses(hoy, 1), fechaRealizada: null }];
  assert.equal(O.estadoPrograma(acts[1]), "atrasada");
  assert.equal(O.estadoPrograma(acts[2]), "pendiente");
  const av = O.avancePrograma(acts);
  assert.equal(av.total.porcentaje, 33);
  assert.equal(av.total.atrasadas, 1);
  assert.deepEqual(av.porResponsable.map((x) => [x.responsable, x.porcentaje]), [["A", 50], ["B", 0]]);
});

test("programa: hoja mensual solo para personas del programa y sin duplicar", () => {
  const personas = [{ id: "p1", nombre: "Pía Prevención", cargo: "Prevencionista" }];
  const plantillas = [{ anio: 2026, mes: 12, cargo: "prevencionista", focoCritico: "Altura", actividades: [{ id: "x", nombre: "Inspección", proy: [1, 0, 1, 0] }] }];
  const hoja = O.hojaMensualACrear({ responsable: "pia prevencion", fechaProgramada: "2026-12-10" }, personas, [], plantillas);
  assert.equal(hoja.nombre, "Pía Prevención");
  assert.equal(hoja.focoCritico, "Altura");
  assert.deepEqual(hoja.actividades[0].proy, [1, 0, 1, 0]);
  assert.equal(O.hojaMensualACrear({ responsable: "Pía Prevención", fechaProgramada: "2026-12-10" }, personas, [hoja], plantillas), null);
  assert.equal(O.hojaMensualACrear({ responsable: "Otra Persona", fechaProgramada: "2026-12-10" }, personas, [], plantillas), null);
});

test("capacitación: convocados, sincronización y realizada automática", () => {
  const trabs = [{ id: "t1", cargo: "Liniero" }, { id: "t2", cargo: "Maestro" }, { id: "t3", cargo: "liniero" }];
  assert.deepEqual(O.convocadosDe({ tipo: "cargos", cargos: ["Liniero"] }, trabs), ["t1", "t3"]);
  const rec = { fechaProgramada: "2026-01-10", participantes: [{ trabajadorId: "t2", asistio: true }, { trabajadorId: "t9", asistio: false }] };
  O.sincronizarParticipantes(rec, { tipo: "cargos", cargos: ["Liniero"] }, trabs);
  assert.deepEqual(rec.participantes.map((p) => p.trabajadorId), ["t2", "t1", "t3"]); // conserva al asistente, quita al no asistente
  O.actualizarRealizada(rec, "2026-02-01");
  assert.equal(rec.fechaRealizada, "2026-01-10");
  assert.equal(rec.realizadaAuto, true);
  rec.participantes.forEach((p) => { p.asistio = false; });
  O.actualizarRealizada(rec, "2026-02-01");
  assert.equal(rec.fechaRealizada, null);
});

test("cursos obligatorios: tramo, rol, último registro y vencimiento", () => {
  assert.equal(O.tramoMinimoAplica("mas-25", 25), false);
  assert.equal(O.tramoMinimoAplica("mas-25", 26), true);
  assert.equal(O.tramoMinimoAplica("10-25-sin-comite", 10), true);
  assert.equal(O.cursoAplica({ aplicaA: ["comite_paritario"], tramoMinimo: "todas" }, { roles: [] }, 50), false);
  assert.equal(O.cursoAplica({ aplicaA: ["todos"], tramoMinimo: "todas" }, { roles: [] }, 5), true);
  const regs = [{ trabajadorId: "t", cursoId: "c", fechaAprobacion: "2024-01-01", fechaVencimiento: "2026-01-01" }, { trabajadorId: "t", cursoId: "c", fechaAprobacion: "2025-06-01", fechaVencimiento: "2027-06-01" }];
  assert.equal(O.ultimoCurso("t", "c", regs).fechaAprobacion, "2025-06-01");
  assert.equal(O.estadoVencimientoCurso(null, "2026-11-02"), "nunca");
  assert.equal(O.estadoVencimientoCurso({ fechaVencimiento: "2026-11-01" }, "2026-11-02"), "vencido");
  assert.equal(O.estadoVencimientoCurso({ fechaVencimiento: "2026-12-15" }, "2026-11-02"), "proximo");
  assert.equal(O.estadoVencimientoCurso({ fechaVencimiento: null }, "2026-11-02"), "vigente");
  // la app guarda a veces la fecha como ISO completo (Date de JS a medianoche en Chile)
  assert.equal(O.estadoVencimientoCurso({ fechaVencimiento: "2026-11-02T03:00:00.000Z" }, "2026-11-02"), "proximo");
  assert.equal(O.fechaVencimientoCurso({ vigenciaAnios: 2 }, "2026-02-28"), "2028-02-28");
  assert.equal(O.fechaVencimientoCurso({ vigenciaAnios: 0 }, "2026-02-28"), null);
});

test("documentos: versión vigente y criterio de vencimiento acordado", () => {
  const docs = [{ id: "1", tipo: "politica", nombre: "Política  SST", fechaActualizacion: "2025-01-01" }, { id: "2", tipo: "politica", nombre: "política sst", fechaActualizacion: "2026-01-01" }];
  assert.equal(O.documentosVigentesMap(docs).get(O.documentoKey(docs[0])).id, "2");
  const hoy = "2026-11-02";
  assert.equal(O.vencimientoDocumento({ fechaRevision: "2026-11-01" }, hoy).vencido, true);
  assert.equal(O.vencimientoDocumento({ fechaRevision: "2026-11-02" }, hoy).vencido, false);
  assert.equal(O.vencimientoDocumento({ fechaActualizacion: "2025-11-01" }, hoy).vencido, true);
  assert.equal(O.vencimientoDocumento({ fechaActualizacion: "2025-11-03" }, hoy).vencido, false);
  assert.equal(O.vencimientoDocumento({}, hoy).sinFechas, true);
});

test("validador de argumentos", () => {
  const s = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "integer", minimum: 1, maximum: 5 }, f: { type: "string", format: "date" }, e: { type: "string", enum: ["x"] } } };
  assert.deepEqual(U.validarEsquema(s, { a: 3 }), []);
  assert.equal(U.validarEsquema(s, {}).length, 1);
  assert.equal(U.validarEsquema(s, { a: 6 }).length, 1);
  assert.equal(U.validarEsquema(s, { a: 1, f: "2026-02-30" }).length, 1);
  assert.equal(U.validarEsquema(s, { a: 1, e: "y" }).length, 1);
  assert.equal(U.validarEsquema(s, { a: 1, z: 1 }).length, 1);
  assert.equal(U.validarEsquema(s, { a: 2.5 }).length, 1);
});

test("adjuntos en base64 se omiten en respuestas y se resumen en auditoría", () => {
  const data = "data:application/pdf;base64," + "A".repeat(500);
  assert.equal(U.omitirAdjuntos({ x: { archivoData: data } }).x.archivoData, "[archivo adjunto: no se muestra por el conector]");
  const aud = U.omitirAdjuntos({ archivoData: data }, "auditoria").archivoData;
  assert.equal(aud.adjuntoOmitido, true);
  assert.equal(aud.bytes, data.length);
  assert.equal(U.omitirAdjuntos({ texto: "data:corto" }).texto, "data:corto");
  // las fechas no se pierden (bug visto en staging: "momento": {} en la auditoría)
  assert.equal(U.omitirAdjuntos({ momento: new Date("2026-11-15T14:00:00Z") }).momento, "2026-11-15T14:00:00.000Z");
});
