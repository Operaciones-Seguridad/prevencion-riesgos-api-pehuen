"use strict";
// Dotación mensual y evaluación DS 67 (datos inventados con el mismo patrón
// del simulador de la mutualidad: 36 meses, incluidos meses con 0 trabajadores).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const A = require("./ayudantes");
const { construirEmpresas, insertar, hoyChile } = require("../scripts/datos-prueba");
const D = require("../mcp/dominio/ds67");

const hash = (c) => { const s = crypto.randomBytes(16).toString("hex"); return `scrypt:${s}:${crypto.scryptSync(c, s, 64).toString("hex")}`; };
let pool, srv, base;
const tok = {};
const H = (rol, n, a) => A.herramienta(base, tok[rol], n, a);
// Jul-2024 a Jun-2027 (evaluación 2027)
const DOT = [10, 12, 12, 11, 12, 12, 8, 6, 8, 8, 10, 11, /* II */ 9, 9, 9, 10, 11, 11, 11, 11, 12, 4, 11, 2, /* III */ 2, 2, 0, 0, 7, 7, 7, 7, 7, 7, 7, 7];
const MESES = D.periodos(2027).flatMap((p) => p.meses);

test.before(async () => {
  pool = await A.prepararBase();
  srv = await A.arrancarServidor(); base = srv.base;
  await insertar(pool, construirEmpresas(hoyChile(), hash(A.CLAVE)));
  for (const r of ["admin", "prevencionista", "capacitacion"]) tok[r] = (await A.conectar(base, A.correo(r))).token;
});
test.after(async () => { await srv.detener(); await pool.end(); });

test("períodos DS 67: tres años de prevención de julio a junio", () => {
  const p = D.periodos(2027);
  assert.deepEqual(p.map((x) => [x.desde, x.hasta]), [["Jul 2024", "Jun 2025"], ["Jul 2025", "Jun 2026"], ["Jul 2026", "Jun 2027"]]);
  assert.equal(MESES.length, 36);
});

test("permisos: la dotación y el DS 67 están en la vista Accidentabilidad", async () => {
  assert.match((await H("capacitacion", "dotacion_cargar", { meses: [{ periodo: "2026-01", promedio_trabajadores: 1 }] })).texto, /no tiene acceso/);
});

test("carga en bloque solo la dotación, con meses en 0, y el promedio calza con la mutualidad", async () => {
  let r = await H("prevencionista", "dotacion_cargar", { meses: [{ periodo: "2026-13", promedio_trabajadores: 1 }] });
  assert.match(r.texto, /formato no válido/);
  r = await H("prevencionista", "dotacion_cargar", { meses: [{ periodo: "2026-01", promedio_trabajadores: 1 }, { periodo: "2026-01", promedio_trabajadores: 2 }] });
  assert.match(r.texto, /repetido/);
  r = await H("prevencionista", "dotacion_cargar", { meses: MESES.map((m, i) => ({ periodo: m, promedio_trabajadores: DOT[i] })) });
  assert.equal(r.error, false, r.texto);
  assert.equal(r.datos.creados.length, 36);
  assert.match(r.datos.aviso, /quedan en 0/);
  const { rows } = await pool.query("SELECT data FROM records WHERE company_id='prueba-andes' AND store='horasHombre' AND data->>'periodo'='2026-09'");
  assert.deepEqual([rows[0].data.promedioTrabajadores, rows[0].data.horasHombre], [0, 0], "mes con 0 trabajadores guardado");
  const ev = (await H("prevencionista", "ds67_evaluacion", { anio_evaluacion: 2027 })).datos;
  const esperado = [0, 1, 2].map((i) => Math.round((DOT.slice(i * 12, i * 12 + 12).reduce((a, b) => a + b, 0) / 12) * 100) / 100);
  assert.deepEqual(ev.periodos.map((p) => p.promedioTrabajadores), esperado, "promedio sobre los 12 meses, contando los meses en 0");
  assert.equal(ev.periodos[2].promedioTrabajadores, 5, "(2+2+0+0+7×8)/12 = 5: los meses en 0 cuentan");
  assert.deepEqual(ev.mesesFaltantes, []);
  // Días perdidos automáticos desde el registro de accidentes de la app: solo
  // CTP/STP (el accidente de trayecto de los datos de prueba no cuenta).
  const accs = (await pool.query("SELECT data FROM records WHERE company_id='prueba-andes' AND store='accidentes'")).rows.map((x) => x.data);
  const esperadoDias = D.periodos(2027).map((p) => accs.filter((x) => ["ctp", "stp"].includes(x.tipo) && p.meses.includes(x.fecha.slice(0, 7))).reduce((a, x) => a + x.diasPerdidos, 0));
  assert.deepEqual(ev.periodos.map((p) => p.diasPerdidosATAuto), esperadoDias);
  const tasas = ev.periodos.map((p) => p.tasa);
  assert.equal(ev.tasaSiniestralidadTotal, Math.round((tasas.reduce((a, b) => a + b, 0) / 3) * 100) / 100);
  const l = (await H("prevencionista", "dotacion_listar", { desde: "2024-07", hasta: "2027-06" })).datos;
  assert.equal(l.mesesSinHorasHombre.length, 36);
});

test("re-cargar no pisa datos sin permiso y conserva las horas-hombre ya registradas", async () => {
  // el usuario completa las horas-hombre de un mes (como desde la app)
  await pool.query("UPDATE records SET data = data || '{\"horasHombre\": 1980}' WHERE company_id='prueba-andes' AND store='horasHombre' AND data->>'periodo'='2025-01'");
  let r = await H("prevencionista", "dotacion_cargar", { meses: [{ periodo: "2025-01", promedio_trabajadores: 9 }, { periodo: "2025-02", promedio_trabajadores: 6 }] });
  assert.match(r.texto, /ya tienen otra dotación/);
  r = await H("prevencionista", "dotacion_cargar", { meses: [{ periodo: "2025-01", promedio_trabajadores: 9 }, { periodo: "2025-02", promedio_trabajadores: 6 }], sobrescribir: true });
  assert.equal(r.error, false, r.texto);
  assert.deepEqual(r.datos.actualizados, ["2025-01"]); assert.deepEqual(r.datos.sinCambios, ["2025-02"]);
  const { rows } = await pool.query("SELECT data FROM records WHERE company_id='prueba-andes' AND store='horasHombre' AND data->>'periodo'='2025-01'");
  assert.deepEqual([rows[0].data.promedioTrabajadores, rows[0].data.horasHombre], [9, 1980], "las horas-hombre del usuario se conservan");
  const n = (await pool.query("SELECT count(*)::int n FROM records WHERE company_id='prueba-andes' AND store='horasHombre'")).rows[0].n;
  assert.equal(n, 36, "no se duplican meses");
});

test("guardar la evaluación: invalideces y corrección de días perdidos por período", async () => {
  const r = await H("prevencionista", "ds67_evaluacion_guardar", { anio_evaluacion: 2027, factor_invalidez_muertes: 0, tasa_invalidez_muertes: 0, dias_perdidos: [{ periodo: 2, accidentes_trabajo: 20 }] });
  assert.equal(r.error, false, r.texto);
  const p2 = r.datos.evaluacion.periodos[1];
  assert.equal(p2.tieneCorreccion, true);
  assert.equal(p2.totalDiasPerdidos, 20);
  assert.equal(p2.tasa, 218.18, "20 / (110/12) × 100, con el promedio sin redondear como la app");
  assert.equal(r.datos.evaluacion.periodos[0].tieneCorreccion, false, "los demás períodos siguen automáticos");
  const reg = (await pool.query("SELECT data FROM records WHERE company_id='prueba-andes' AND store='ds67Evaluaciones'")).rows;
  assert.equal(reg.length, 1);
  assert.deepEqual(reg[0].data.periodosOverride[1], { diasPerdidosAT: 20, diasPerdidosEP: 0 });
  assert.equal(reg[0].data.periodosOverride[0], null);
  const aud = (await pool.query("SELECT count(*)::int n FROM auditoria_escrituras WHERE herramienta IN ('dotacion_cargar','ds67_evaluacion_guardar')")).rows[0].n;
  assert.equal(aud, 36 + 1 + 1, "cada mes y la evaluación quedan auditados");
});
