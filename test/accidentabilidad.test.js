"use strict";
// Pruebas del módulo Accidentabilidad del conector (fase 2).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const A = require("./ayudantes");
const { construirEmpresas, insertar, hoyChile } = require("../scripts/datos-prueba");

const hash = (c) => { const s = crypto.randomBytes(16).toString("hex"); return `scrypt:${s}:${crypto.scryptSync(c, s, 64).toString("hex")}`; };
// Imagen de tamaño realista (los adjuntos de menos de 200 caracteres no se ocultan).
const PNG = "data:image/png;base64," + crypto.randomBytes(3000).toString("base64");
let pool, srv, base;
const tok = {};
const H = (rol, n, a) => A.herramienta(base, tok[rol], n, a);
const reg = async (store, id) => (await pool.query("SELECT data FROM records WHERE company_id='prueba-andes' AND store=$1 AND id=$2", [store, id])).rows[0]?.data;

test.before(async () => {
  pool = await A.prepararBase();
  srv = await A.arrancarServidor(); base = srv.base;
  await insertar(pool, construirEmpresas(hoyChile(), hash(A.CLAVE)));
  for (const r of ["admin", "prevencionista", "supervisor", "capacitacion"]) tok[r] = (await A.conectar(base, A.correo(r))).token;
});
test.after(async () => { await srv.detener(); await pool.end(); });

test("permisos: solo perfiles con la vista Accidentabilidad ven el módulo", async () => {
  const nombres = async (r) => new Set((await A.rpc(base, tok[r], "tools/list", {})).body.result.tools.map((t) => t.name));
  assert.ok((await nombres("prevencionista")).has("investigacion_transito_crear"));
  assert.ok((await nombres("supervisor")).has("accidente_registrar"));
  const cap = await nombres("capacitacion");
  assert.ok(!cap.has("accidentes_listar") && !cap.has("arbol_causas_crear"));
  assert.match((await H("capacitacion", "accidentes_listar", {})).texto, /no tiene acceso/);
});

test("lectura: listado, detalle y catálogos", async () => {
  const l = await H("prevencionista", "accidentes_listar", {});
  assert.equal(l.datos.total, 3);
  assert.equal(l.datos.resultados[0].tipo, "Incidente / cuasi accidente", "más reciente primero");
  assert.equal((await H("prevencionista", "accidentes_listar", { tipo: "ctp" })).datos.resultados[0].denuncia.sigla, "DIAT");
  assert.equal((await H("prevencionista", "accidentes_listar", { sin_investigar: true })).datos.total, 3);
  const c = await H("prevencionista", "accidentabilidad_catalogos", {});
  assert.equal(c.datos.transito.listaVerificacion.length, 17);
  assert.equal(c.datos.transito.superficies.grava.mu > 0, true);
  assert.ok(c.datos.tiposIncidente.includes("Caída de objetos"));
});

test("accidente: validaciones de la app (grave, DIAT) y avisos legales", async () => {
  const base1 = { tipo: "ctp", fecha: "2026-11-10", area: "Terreno", trabajadores_ids: ["trab-6-andes"], causa: "Colisión de camión con unidad detenida", descripcion: "Prueba" };
  let r = await H("prevencionista", "accidente_registrar", Object.assign({}, base1, { gravedad: "grave" }));
  assert.match(r.texto, /marca al menos uno de los criterios/);
  r = await H("prevencionista", "accidente_registrar", Object.assign({}, base1, { gravedad: "leve", denuncia_realizada: "si" }));
  assert.match(r.texto, /fecha en que se presentó la DIAT/);
  r = await H("prevencionista", "accidente_registrar", Object.assign({}, base1, { trabajadores_ids: ["no-existe"] }));
  assert.match(r.texto, /no existen/);
  r = await H("prevencionista", "accidente_registrar", Object.assign({}, base1, { gravedad: "grave", criterios_grave: ["rescate"], denuncia_realizada: "si", fecha_denuncia: "2026-11-10", dias_perdidos: 15 }));
  assert.equal(r.error, false, r.texto);
  assert.ok(r.datos.avisos.some((x) => /suspender de inmediato/.test(x)));
  const acc = await reg("accidentes", r.datos.id);
  assert.deepEqual(acc.criteriosGrave, ["rescate"]);
  assert.equal(acc.investigado, false);
  // enfermedad profesional: la gravedad no aplica y la denuncia es DIEP
  r = await H("prevencionista", "accidente_registrar", { tipo: "enfermedad", fecha: "2026-11-01", area: "Taller", gravedad: "grave", denuncia_realizada: "si" });
  assert.match(r.texto, /DIEP/);
  r = await H("prevencionista", "accidente_registrar", { tipo: "enfermedad", fecha: "2026-11-01", area: "Taller", gravedad: "grave", criterios_grave: ["caida"] });
  assert.equal((await reg("accidentes", r.datos.id)).gravedad, "leve");
});

test("incidente y actualización conservan el tipo y los adjuntos", async () => {
  let r = await H("supervisor", "incidente_registrar", { fecha: "2026-11-12", area: "Taller", tipo_incidente: "Algo inventado" });
  assert.match(r.texto, /Tipo de incidente no válido/);
  r = await H("supervisor", "incidente_registrar", { fecha: "2026-11-12", area: "Taller", tipo_incidente: "condicion insegura", danio_propiedad: true, descripcion_danio: "Rayado de puerta" });
  assert.equal(r.error, false, r.texto);
  const inc = await reg("accidentes", r.datos.id);
  assert.equal(inc.tipoIncidente, "Condición insegura");
  assert.equal(inc.danioPropiedad, "si");
  // actualizar un accidente con informe adjunto no lo borra
  await pool.query("UPDATE records SET data = data || '{\"informePreliminar\":\"data:application/pdf;base64,AAAA\",\"informePreliminarNombre\":\"informe.pdf\"}' WHERE company_id='prueba-andes' AND store='accidentes' AND id='acc-1-andes'");
  const det = (await H("prevencionista", "accidente_detalle", { id: "acc-1-andes" })).datos;
  r = await H("prevencionista", "accidente_actualizar", { id: "acc-1-andes", version_esperada: det.resumen._version, dias_perdidos: 5 });
  assert.equal(r.error, false, r.texto);
  const acc = await reg("accidentes", "acc-1-andes");
  assert.equal(acc.diasPerdidos, 5);
  assert.equal(acc.informePreliminarNombre, "informe.pdf");
  r = await H("prevencionista", "accidente_actualizar", { id: inc.id, version_esperada: (await H("supervisor", "accidente_detalle", { id: inc.id })).datos.resumen._version, tipo: "ctp" });
  assert.match(r.texto, /no se puede convertir/);
});

test("investigación formal: una por accidente, listas oficiales y versión al actualizar", async () => {
  let r = await H("prevencionista", "investigacion_accidente_guardar", { accidente_id: "acc-1-andes" });
  assert.match(r.texto, /nombre del accidentado/);
  r = await H("prevencionista", "investigacion_accidente_guardar", { accidente_id: "acc-1-andes", nombre_accidentado: "Bruno Ejemplo Dos", tipo_accidente: ["Inventado"] });
  assert.match(r.texto, /valor no permitido/);
  r = await H("prevencionista", "investigacion_accidente_guardar", {
    accidente_id: "acc-1-andes", nombre_accidentado: "Bruno Ejemplo Dos", cargo: "Maestro", partes_cuerpo: ["Manos"],
    factores_trabajo: ["Mantención deficiente"], medidas_correctivas: [{ accion: "Instalar guarda", responsable: "Sergio", fecha: "2026-12-01" }],
  });
  assert.equal(r.error, false, r.texto);
  r = await H("prevencionista", "investigacion_accidente_guardar", { accidente_id: "acc-1-andes", nombre_accidentado: "Otro" });
  assert.match(r.texto, /ya tiene investigación formal/);
  const det = (await H("prevencionista", "accidente_detalle", { id: "acc-1-andes" })).datos;
  assert.equal(det.investigacionFormal.cargo, "Maestro");
  r = await H("prevencionista", "investigacion_accidente_guardar", { accidente_id: "acc-1-andes", version_esperada: det.investigacionFormal._version, investigador_nombre: "Pía Prevención Ficticia" });
  assert.equal(r.error, false, r.texto);
  const inv = (await pool.query("SELECT data FROM records WHERE company_id='prueba-andes' AND store='accInvestigaciones'")).rows;
  assert.equal(inv.length, 1, "sigue habiendo una sola investigación");
  assert.equal(inv[0].data.cargo, "Maestro", "conserva lo que no se envió");
  assert.equal(inv[0].data.investigadorNombre, "Pía Prevención Ficticia");
});

test("árbol de causas: referencias, ciclos, avisos de juicio y edición conservando ids", async () => {
  const hechos = [
    { ref: "h1", texto: "El conductor no ve la unidad detenida", tipo: "individuo", antecede_a: ["central"], medida_correctiva: "Capacitación en conducción defensiva", plazo: "corto" },
    { ref: "h2", texto: "Curva sin visibilidad hacia el km 58", tipo: "entorno", antecede_a: ["h1"] },
    { ref: "h3", texto: "Conductor negligente", tipo: "individuo", antecede_a: ["h1"] },
  ];
  let r = await H("prevencionista", "arbol_causas_crear", { accidente_id: "acc-2-andes", hecho_central: "Choque por alcance", hechos: [{ ref: "a", texto: "x", tipo: "tarea", antecede_a: ["zzz"] }] });
  assert.match(r.texto, /no existe en la lista/);
  r = await H("prevencionista", "arbol_causas_crear", { accidente_id: "acc-2-andes", hecho_central: "Choque", hechos: [{ ref: "a", texto: "x", tipo: "tarea", antecede_a: ["b"] }, { ref: "b", texto: "y", tipo: "tarea", antecede_a: ["a"] }] });
  assert.match(r.texto, /ciclo/);
  r = await H("prevencionista", "arbol_causas_crear", { accidente_id: "acc-2-andes", hecho_central: "Choque por alcance con lesión cervical", hechos });
  assert.equal(r.error, false, r.texto);
  assert.match(r.datos.avisos[0], /palabras de juicio/);
  const arbol = await reg("arbolesCausales", r.datos.id);
  const h1 = arbol.hechos[0], h2 = arbol.hechos[1];
  assert.deepEqual(h1.precedeA, ["central"]);
  assert.deepEqual(h2.precedeA, [h1.id], "las refs se convierten en ids de la app");
  assert.equal(h1.plazo, "corto"); assert.equal(h2.plazo, "corto", "plazo por defecto");
  const det = (await H("prevencionista", "accidente_detalle", { id: "acc-2-andes" })).datos;
  r = await H("prevencionista", "arbol_causas_actualizar", { id: arbol.id, version_esperada: det.arbolesDeCausas[0]._version, hechos: [
    { ref: h1.id, texto: h1.texto, tipo: "individuo" }, { ref: h2.id, texto: h2.texto, tipo: "entorno", antecede_a: [h1.id] },
  ], conclusion: "Visibilidad y atención" });
  assert.equal(r.error, false, r.texto);
  const nuevo = await reg("arbolesCausales", arbol.id);
  assert.deepEqual(nuevo.hechos.map((h) => h.id), [h1.id, h2.id], "conserva los ids existentes");
  assert.equal(nuevo.conclusion, "Visibilidad y atención");
});

test("tránsito: automatismos del formulario, lista de verificación, fotos, faltantes y cálculo", async () => {
  let r = await H("prevencionista", "investigacion_transito_crear", { fecha: "2026-11-10" });
  assert.match(r.texto, /fecha y el área/);
  r = await H("prevencionista", "investigacion_transito_crear", { fecha: "2026-11-10", area: "Terreno", fotos: ["data:image/gif;base64,AAAA"] });
  assert.match(r.texto, /JPG, PNG o WEBP/);
  r = await H("prevencionista", "investigacion_transito_crear", { fecha: "2026-11-10", area: "Terreno", fotos: ["data:image/jpeg;base64," + "A".repeat(2.2 * 1024 * 1024)] });
  assert.match(r.texto, /máximo es 1,5 MB/);
  r = await H("prevencionista", "investigacion_transito_crear", { fecha: "2026-11-10", area: "Terreno", hora: "2pm" });
  assert.match(r.texto, /formato no válido/);
  r = await H("prevencionista", "investigacion_transito_crear", {
    fecha: "2026-11-10", hora: "14:19", area: "Terreno", accidente_id: "acc-2-andes", tipo_accidente: "colision-trasera",
    vehiculo: "Camión tolva AB-CD-12 (prueba)", condicion_calzada: "grava", estado_conductor: "fatiga", velocidad_conocida: 70, velocidad_maxima: 60,
    lista_verificacion: [{ item: 1, estado: "ok" }, { item: 2, estado: "fail" }], fotos: [PNG, PNG],
  });
  assert.equal(r.error, false, r.texto);
  const rec = await reg("transitoInvestigaciones", r.datos.id);
  assert.equal(rec.coefFriccion, 0.6 > 0 ? require("../mcp/dominio/catalogos-accidentabilidad.json").COEF_FRICCION_REF.grava.mu : 0, "μ de referencia de la grava");
  assert.equal(rec.tiempoReaccion, 2, "tiempo de reacción sugerido con fatiga");
  assert.equal(rec.items[0].estado, "ok"); assert.equal(rec.items[1].estado, "fail"); assert.equal(rec.items[2].estado, "");
  assert.equal(rec.fotosAdicionales.length, 2);
  assert.equal(rec.coefFriccionPostImpacto, require("../mcp/dominio/catalogos-accidentabilidad.json").COEF_FRICCION_REF["asfalto-seco"].mu, "valores iniciales del formulario");
  assert.equal(r.datos.calculo.excesoKmh, 10);
  assert.ok(r.datos.faltaParaCompletar.includes("Responsable de la investigación"));
  assert.ok(!r.datos.faltaParaCompletar.some((x) => /Croquis/.test(x)), "con fotos ya no falta el croquis/fotografía");
  assert.ok(r.datos.faltaParaCompletar.some((x) => /15 ítem/.test(x)));
  // actualizar agrega fotos y cambia solo los ítems indicados
  const det = (await H("prevencionista", "investigacion_transito_detalle", { id: rec.id })).datos;
  assert.ok(!JSON.stringify(det).includes(PNG.slice(30, 90)), "las fotos no se devuelven");
  assert.ok(JSON.stringify(det.registro.fotosAdicionales).includes("archivo adjunto"), "se muestran como marcador");
  r = await H("prevencionista", "investigacion_transito_actualizar", { id: rec.id, version_esperada: det._version, lista_verificacion: [{ item: 3, estado: "na" }], fotos: [PNG], responsable: "Pía Prevención Ficticia" });
  assert.equal(r.error, false, r.texto);
  const rec2 = await reg("transitoInvestigaciones", rec.id);
  assert.equal(rec2.fotosAdicionales.length, 3);
  assert.deepEqual(rec2.items.slice(0, 3).map((i) => i.estado), ["ok", "fail", "na"]);
  // queda vinculada al accidente
  const acc = (await H("prevencionista", "accidente_detalle", { id: "acc-2-andes" })).datos;
  assert.equal(acc.investigacionesTransito.length, 1);
  assert.equal(acc.resumen.investigacionesTransito, 1);
});

test("auditoría de Accidentabilidad: cada escritura queda registrada y las fotos solo como hash", async () => {
  const { rows } = await pool.query("SELECT herramienta, store, valor_nuevo FROM auditoria_escrituras WHERE company_id='prueba-andes'");
  const usadas = new Set(rows.map((r) => r.herramienta));
  for (const h of ["accidente_registrar", "incidente_registrar", "accidente_actualizar", "investigacion_accidente_guardar", "arbol_causas_crear", "arbol_causas_actualizar", "investigacion_transito_crear", "investigacion_transito_actualizar"]) assert.ok(usadas.has(h), "sin auditoría: " + h);
  const t = rows.find((r) => r.herramienta === "investigacion_transito_crear");
  assert.equal(t.valor_nuevo.fotosAdicionales.length, 2);
  assert.ok(t.valor_nuevo.fotosAdicionales.every((f) => f.adjuntoOmitido && f.sha256), "la auditoría guarda solo hash y tamaño de cada foto");
});
