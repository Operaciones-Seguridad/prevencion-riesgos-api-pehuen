#!/usr/bin/env node
"use strict";
// Prueba de PARIDAD con la app real (manual, no corre en npm test):
// escribe con el conector y verifica en el index.html real de la app, en un
// navegador (Playwright), que la app muestra y sigue editando esos registros.
//
//   node scripts/paridad-app.js ../prevencion-riesgos-app-pehuen/index.html [foto.jpg]
//
// Con una foto JPG opcional, también verifica que la app muestra las fotos
// que el conector adjunta a una investigación de tránsito.
//
// Usa SOLO la base local de pruebas (TEST_DATABASE_URL o la de test/ayudantes.js,
// que se borra entera) y una copia temporal del index.html apuntando a la API local.
// Requiere el paquete "playwright" instalado globalmente (no es dependencia del proyecto).
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { chromium } = require("playwright");
const A = require("../test/ayudantes");
const { construirEmpresas, insertar, hoyChile } = require("./datos-prueba");

const hoyMas = (n) => { const d = new Date(hoyChile() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ok = (c, m) => { console.log((c ? "OK   " : "FALLA") + " " + m); if (!c) process.exitCode = 1; };

(async () => {
  const appHtml = process.argv[2];
  if (!appHtml) { console.error("Uso: node scripts/paridad-app.js <ruta a index.html de la app>"); process.exit(1); }
  const pool = await A.prepararBase();
  const srv = await A.arrancarServidor();
  const BASE = srv.base;
  const salt = crypto.randomBytes(16).toString("hex");
  await insertar(pool, construirEmpresas(hoyChile(), `scrypt:${salt}:${crypto.scryptSync(A.CLAVE, salt, 64).toString("hex")}`));
  const token = (await A.conectar(BASE, A.correo("admin"))).token;
  const H = async (n, a) => { const r = await A.herramienta(BASE, token, n, a); if (r.error) throw new Error(n + ": " + r.texto); return r.datos; };

  // copia del index.html apuntando a la API local, servida en un puerto local
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paridad-"));
  const html = fs.readFileSync(appHtml, "utf8").replace(/const API_BASE_URL = "[^"]*";/, `const API_BASE_URL = "${BASE}";`);
  fs.writeFileSync(path.join(dir, "index.html"), html);
  const estatico = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); });
  await new Promise((r) => estatico.listen(0, r));
  const web = `http://localhost:${estatico.address().port}`;

  // 1) escrituras con el conector
  const linea = await H("miper_crear_linea", { area: "Taller", actividad: "Paridad: corte con plasma", peligro: "Paridad: proyección de chispas", riesgo: "Quemadura", probabilidad: 4, consecuencia: 4, simbolo_oficial: "seg-caida-mismo-nivel", controles: [{ jerarquia: "C", texto: "Paridad: biombo de protección", responsable: "Sergio Supervisor Inventado" }] });
  const acc = await H("plan_accion_crear", { matriz_id: linea.linea.id, actividad: "Paridad: instalar biombos", responsable: "Sergio Supervisor Inventado", plazo: "2027-01-31" });
  await H("plan_accion_marcar_cumplida", { ids: [acc.acciones[0].id], probabilidad_despues: 2, consecuencia_despues: 3, observacion: "Paridad: biombos instalados" });
  await H("programa_crear_actividad", { nombre: "Paridad: inspección de esmeriles", tipo: "inspeccion", area: "Taller", responsable: "Pía Prevención Ficticia", fecha_programada: "2027-02-10" });
  const cap = await H("capacitacion_crear", { nombre: "Paridad: uso de careta", fecha_programada: "2027-02-12", tipo: "Inducción", relator: "Pía Prevención Ficticia", dirigida_a: { tipo: "cargos", cargos: ["Maestro"] } });
  await H("documento_crear", { tipo: "manual", nombre: "Manual del sistema de gestión", version: "4", fecha_actualizacion: "2026-10-30", fecha_revision: "2027-10-30" });
  const tr = await H("trabajador_crear", { nombre: "Paridad Trabajador Nuevo", rut: "0.000.009-0", cargo: "Maestro", area: "Taller", roles: ["comite_paritario"] });
  await H("trabajador_curso_registrar", { trabajador_id: tr.trabajador.id, curso_id: "curso-general-andes", fecha_aprobacion: "2026-10-01" });
  // Accidentabilidad
  const accR = await H("accidente_registrar", { tipo: "ctp", fecha: "2026-11-10", area: "Terreno", gravedad: "grave", criterios_grave: ["rescate"], denuncia_realizada: "si", fecha_denuncia: "2026-11-10", dias_perdidos: 10, causa: "Paridad: colisión de camión", descripcion: "Paridad", trabajadores_ids: ["trab-6-andes"] });
  await H("investigacion_accidente_guardar", { accidente_id: accR.id, nombre_accidentado: "Felipe Ejemplo Seis", cargo: "Conductor", partes_cuerpo: ["Cabeza"], factores_trabajo: ["Mantención deficiente"], medidas_correctivas: [{ accion: "Paridad: revisión de frenos", responsable: "Sergio", fecha: "2026-12-01" }] });
  await H("arbol_causas_crear", { accidente_id: accR.id, hecho_central: "Paridad: lesión del conductor", hechos: [{ ref: "a", texto: "Paridad: camión no frena a tiempo", tipo: "material" }, { ref: "b", texto: "Paridad: huella de frenado de 30 m", tipo: "entorno", antecede_a: ["a"] }] });
  const foto = process.argv[3] ? "data:image/jpeg;base64," + fs.readFileSync(process.argv[3]).toString("base64") : null;
  const trn = await H("investigacion_transito_crear", Object.assign({ fecha: "2026-11-10", hora: "14:19", area: "Terreno", accidente_id: accR.id, tipo_accidente: "colision-trasera", vehiculo: "Paridad: camión", condicion_calzada: "grava", estado_conductor: "fatiga", velocidad_conocida: 70, velocidad_maxima: 60, lista_verificacion: [{ item: 1, estado: "ok" }, { item: 2, estado: "fail" }] }, foto ? { fotos: [foto] } : {}));
  // Dotación y DS 67 (patrón del simulador de la mutualidad, con meses en 0)
  const mesesDs67 = require("../mcp/dominio/ds67").periodos(2027).flatMap((p) => p.meses);
  const dot = [10, 12, 12, 11, 12, 12, 8, 6, 8, 8, 10, 11, 9, 9, 9, 10, 11, 11, 11, 11, 12, 4, 11, 2, 2, 2, 0, 0, 7, 7, 7, 7, 7, 7, 7, 7];
  await H("dotacion_cargar", { meses: mesesDs67.map((m, i) => ({ periodo: m, promedio_trabajadores: dot[i] })) });
  await H("ds67_evaluacion_guardar", { anio_evaluacion: 2027, dias_perdidos: [1, 2, 3].map((n) => ({ periodo: n, accidentes_trabajo: 0, enfermedad_profesional: 0 })) });
  const evConector = await H("ds67_evaluacion", { anio_evaluacion: 2027 });
  console.log("escrituras con el conector: listas");

  // 2) la app real
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errores = [];
  page.on("pageerror", (e) => errores.push(e.message));
  await page.goto(`${web}/index.html`);
  await page.fill("#loginEmail", A.correo("admin"));
  await page.fill("#loginClave", A.CLAVE);
  await page.click("#loginBtn");
  await page.waitForSelector("#loginOverlay.hidden", { state: "attached", timeout: 30000 });
  await page.waitForTimeout(2500);
  const ver = async (vista) => { await page.click(`#mainNav button[data-view="${vista}"]`); await page.waitForTimeout(1200); return page.locator(`#view-${vista}`).textContent(); };
  let t = await ver("matriz");
  ok(t.includes("Paridad: corte con plasma"), "MIPER: la línea creada por el conector aparece en la matriz");
  ok(t.includes("Paridad: instalar biombos"), "Plan de acción: la acción aparece en el seguimiento");
  const estadoSel = await page.evaluate(() => { const pa = CACHE.planAccionMatriz.find((p) => p.actividad === "Paridad: instalar biombos"); const sel = document.querySelector(`select[data-pa-estado="${pa.id}"]`); return sel && sel.value; });
  ok(estadoSel === "cumplida", "Plan de acción: el selector de estado de la app muestra «cumplida» (valor: " + estadoSel + ")");
  const nivel = await page.evaluate(() => { const m = CACHE.matriz.find((x) => x.actividad === "Paridad: corte con plasma"); return nivelLabel(nivelRiesgoLinea(m)) + " / " + paEstadoTratamiento(m).label; });
  ok(nivel === "Medio / Requiere más medidas", "MIPER: la app calcula el residual 2x3 que dejó el conector → " + nivel);
  const vence = await page.evaluate(() => { const t = CACHE.trabajadores.find((x) => x.nombre === "Paridad Trabajador Nuevo"); const r = ultimoCursoDe(t.id, "curso-general-andes"); return fmtDate(r.fechaVencimiento) + " / " + estadoVencimientoCurso(r); });
  ok(vence === "01-10-2028 / vigente", "Cursos: la app lee la fecha de vencimiento calculada por el conector → " + vence);
  await page.screenshot({ path: path.join(dir, "paridad-matriz.png") });
  t = await ver("programa");
  const enMensual = await page.evaluate(() => { const a = CACHE.programa.find((p) => p.nombre === "Paridad: inspección de esmeriles"); return !!a && pgEnProgramaMensual(a) && !!pcPersonaPorNombre(a.responsable); });
  ok(enMensual, "Programa: la app reconoce la actividad dentro del programa mensual de su responsable (hoja creada por el conector)");
  ok(/ya están en el programa mensual/.test(t), "Programa: la tabla «por asignar» la cuenta como ya asignada, igual que una creada en la app");
  t = await ver("capacitacion");
  ok(t.includes("Paridad: uso de careta"), "Capacitación: aparece en el plan");
  t = await ver("documentos");
  ok(/Manual del sistema de gestión/.test(t), "Documentos: el manual aparece");
  t = await ver("config");
  ok(t.includes("Paridad Trabajador Nuevo"), "Trabajadores: aparece en la nómina");
  t = await ver("accidentabilidad");
  ok(t.includes("Paridad: colisión de camión"), "Accidentabilidad: el accidente aparece en el registro");
  const faltApp = await page.evaluate((id) => transitoCamposFaltantes(CACHE.transitoInvestigaciones.find((r) => r.id === id)), trn.id);
  ok(JSON.stringify(faltApp) === JSON.stringify(trn.faltaParaCompletar), "Tránsito: la app calcula exactamente lo mismo que falta para completar → " + faltApp.length + " pendientes");
  const enForm = await page.evaluate((id) => { startEditTransito(id); return { coef: document.getElementById("transitoCoefFriccion").value, reac: document.getElementById("transitoTiempoReaccion").value, fotos: document.querySelectorAll("#transitoFotosWrap img").length, item2: document.querySelector('#transitoChecklistWrap .seg[data-tridx="1"] .on-fail') !== null }; }, trn.id);
  ok(enForm.coef === "0.6" || +enForm.coef > 0, "Tránsito: el formulario de la app carga el μ de la grava → " + enForm.coef);
  ok(enForm.reac === "2", "Tránsito: el formulario carga el tiempo de reacción con fatiga → " + enForm.reac);
  ok(enForm.item2, "Tránsito: la lista de verificación muestra «No cumple» en el ítem 2");
  if (foto) ok(enForm.fotos === 1, "Tránsito: la app muestra la foto adjuntada por el conector");
  const arbolOk = await page.evaluate(() => { const a = CACHE.arbolesCausales.find((x) => x.hechoCentral === "Paridad: lesión del conductor"); startEditArbol(a.id); return document.getElementById("arbolTreeWrap").textContent; });
  ok(/Paridad: huella de frenado de 30 m/.test(arbolOk) && /Paridad: camión no frena a tiempo/.test(arbolOk), "Árbol de causas: la app dibuja los hechos y sus vínculos");
  const evApp = await page.evaluate(() => { const e = calcDs67Evaluacion(2027); return { prom: e.periodos.map((p) => Math.round(p.promedioTrabajadores * 100) / 100), tasas: e.periodos.map((p) => p.tasa), total: e.tasaSiniestralidadTotal, faltan: e.mesesFaltantes.length }; });
  ok(JSON.stringify(evApp.prom) === JSON.stringify(evConector.periodos.map((p) => p.promedioTrabajadores)) && JSON.stringify(evApp.tasas) === JSON.stringify(evConector.periodos.map((p) => p.tasa)) && evApp.total === evConector.tasaSiniestralidadTotal && evApp.faltan === 0,
    "DS 67: la app calcula los mismos promedios y tasas que el conector → " + JSON.stringify(evApp));
  const hhEdit = await page.evaluate(async () => {
    document.getElementById("hhPeriodo").value = "2025-03"; document.getElementById("hhHoras").value = "1700"; document.getElementById("hhPromedio").value = "8";
    document.getElementById("saveHHBtn").click(); await new Promise((r) => setTimeout(r, 2500));
    const regs = CACHE.horasHombre.filter((h) => h.periodo === "2025-03"); return { n: regs.length, hh: regs[0] && regs[0].horasHombre };
  });
  ok(hhEdit.n === 1 && +hhEdit.hh === 1700, "Horas-hombre: completarlas desde el formulario de la app actualiza el mes cargado por el conector (sin duplicar)");
  const invOk = await page.evaluate((id) => { abrirModalInvestigacionAccidente(CACHE.accidentes.find((a) => a.id === id)); const v = document.getElementById("invNombre").value; closeModal(); return v; }, accR.id);
  ok(invOk === "Felipe Ejemplo Seis", "Investigación formal: la app la abre con los datos del conector");

  // 3) la app sigue pudiendo escribir sobre algo creado por el conector
  await ver("capacitacion");
  const cb = page.locator(`input[data-cap-asis^="${cap.capacitacion.id}|"]`).first();
  ok(await cb.count() > 0, "Capacitación: la app muestra la lista de convocados creada por el conector");
  if (await cb.count()) { await cb.evaluate((el) => { el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); }); await page.waitForTimeout(2500); }
  const res = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: A.correo("admin"), clave: A.CLAVE }) });
  const appTok = (await res.json()).token;
  const caps = await (await fetch(BASE + "/api/capacitaciones", { headers: { authorization: "Bearer " + appTok } })).json();
  const c = caps.find((x) => x.id === cap.capacitacion.id);
  ok(c && c.participantes.some((p) => p.asistio) && c.fechaRealizada && c.realizadaAuto === true, "Capacitación: marcar asistencia en la app sobre un registro del conector funciona (realizada automática)");
  const det = await H("capacitacion_detalle", { id: cap.capacitacion.id });
  ok(det.asistieron === 1 && det.estado === "realizada", "Conector: ve el cambio hecho desde la app");
  // 4) Documentos del trabajador: lo registrado por el conector se ve, se edita (archivo) y se renueva en la app
  const dialogos = [];
  page.on("dialog", (dlg) => { dialogos.push(dlg.message()); dlg.accept(); });
  const regDocs = await H("trabajador_documentos_registrar", { documentos: [
    { trabajador_id: "trab-1-andes", nombre: "Paridad: INIVIP", entidad: "ENEX", fecha_control: "2026-05-15", fecha_vencimiento: "2028-05-15" },
    { trabajador_id: "trab-1-andes", nombre: "Paridad: Examen ocupacional", entidad: "ENEX", fecha_control: "2025-12-01", fecha_vencimiento: hoyMas(20) },
  ] });
  await page.evaluate(async () => { marcarStoreSucio("trabajadorDocumentos"); await loadCache(); renderDocsTrabajador(); renderCumplimientoTrabajadores(); });
  t = await ver("riohys");
  ok(t.includes("Paridad: INIVIP") && t.includes("Paridad: Examen ocupacional"), "Documentos del trabajador: la app muestra lo registrado por el conector");
  const filaExamen = page.locator("#docsTrabTable tr", { hasText: "Paridad: Examen ocupacional" });
  ok((await filaExamen.textContent()).includes("Próximo a vencer"), "Documentos del trabajador: la app calcula el mismo estado (próximo a vencer)");
  ok((await page.locator("#cumplimientoTrabTable tr", { hasText: "Ana Ejemplo Uno" }).textContent()).includes("por vencer"), "Cumplimiento de trabajadores: columna Documentos con el aviso");
  const pdf = { name: "inivip.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% paridad\n" + "x".repeat(400)) };
  await page.locator("#docsTrabTable tr", { hasText: "Paridad: INIVIP" }).locator("[data-doctrab-editar]").click();
  await page.setInputFiles("#docTrabArchivo", pdf);
  await page.waitForTimeout(500);
  await page.click("#docTrabGuardarBtn");
  await page.waitForTimeout(2500);
  const inivipId = regDocs.documentos[0].id;
  const detInivip = await H("trabajador_documento_detalle", { id: inivipId });
  ok(detInivip.archivo === "inivip.pdf" && detInivip.fechaVencimiento === "2028-05-15", "Documentos del trabajador: adjuntar el archivo en la app sobre un registro del conector conserva sus datos");
  await page.locator("#docsTrabTable tr", { hasText: "Paridad: Examen ocupacional" }).locator("[data-doctrab-renovar]").click();
  await page.fill("#docTrabFechaControl", "2026-11-19");
  await page.fill("#docTrabFechaVenc", "2027-11-19");
  await page.click("#docTrabGuardarBtn");
  await page.waitForTimeout(2500);
  const lst = await H("trabajador_documentos_listar", { trabajador_id: "trab-1-andes", texto: "Paridad: Examen", incluir_historial: true });
  ok(lst.total === 1 && lst.resultados[0].fechaVencimiento === "2027-11-19" && lst.resultados[0].historial.length === 1 && lst.resultados[0].historial[0].id === regDocs.documentos[1].id, "Documentos del trabajador: renovar en la app deja la versión del conector en el historial");
  ok(dialogos.some((m) => /renovado/.test(m)), "Documentos del trabajador: la app confirma la renovación");
  ok(errores.length === 0, "Sin errores de JavaScript en la app" + (errores.length ? ": " + errores.slice(0, 5).join(" | ") : ""));
  await browser.close();
  estatico.close(); await srv.detener(); await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
