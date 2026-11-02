#!/usr/bin/env node
"use strict";
// Prueba de PARIDAD con la app real (manual, no corre en npm test):
// escribe con el conector y verifica en el index.html real de la app, en un
// navegador (Playwright), que la app muestra y sigue editando esos registros.
//
//   node scripts/paridad-app.js ../prevencion-riesgos-app-pehuen/index.html
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
  ok(errores.length === 0, "Sin errores de JavaScript en la app" + (errores.length ? ": " + errores.slice(0, 5).join(" | ") : ""));
  await browser.close();
  estatico.close(); await srv.detener(); await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
