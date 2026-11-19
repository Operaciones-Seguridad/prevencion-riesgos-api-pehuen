"use strict";
// Documentos del trabajador (Inducción y cumplimiento): carpeta personal con
// nombre libre, vencimiento opcional y renovación con historial.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const A = require("./ayudantes");
const { construirEmpresas, insertar, hoyChile } = require("../scripts/datos-prueba");
const O = require("../mcp/dominio/otros");

const hash = (c) => { const s = crypto.randomBytes(16).toString("hex"); return `scrypt:${s}:${crypto.scryptSync(c, s, 64).toString("hex")}`; };
let pool, srv, base;
const tok = {};
const H = (rol, n, a) => A.herramienta(base, tok[rol], n, a);
const T6 = "trab-6-andes", T1 = "trab-1-andes";
async function registro(store, id) { const { rows } = await pool.query("SELECT data FROM records WHERE company_id='prueba-andes' AND store=$1 AND id=$2", [store, id]); return rows[0] ? rows[0].data : null; }
async function cuantos() { return (await pool.query("SELECT count(*)::int n FROM records WHERE store='trabajadorDocumentos'")).rows[0].n; }

test.before(async () => {
  pool = await A.prepararBase();
  srv = await A.arrancarServidor(); base = srv.base;
  await insertar(pool, construirEmpresas(hoyChile(), hash(A.CLAVE)));
  for (const r of ["admin", "prevencionista", "capacitacion", "supervisor"]) tok[r] = (await A.conectar(base, A.correo(r))).token;
  tok.lectura = (await A.conectar(base, A.correo("prevencionista"), { escritura: false })).token;
  tok.sur = (await A.conectar(base, A.correo("admin", "sur"))).token;
});
test.after(async () => { await srv.detener(); await pool.end(); });

test("dominio: estado por fecha de vencimiento y versión actual con historial", () => {
  const hoy = "2026-11-19";
  assert.equal(O.estadoDocTrabajador({ fechaVencimiento: null }, hoy), "sinvenc");
  assert.equal(O.estadoDocTrabajador({ fechaVencimiento: "2026-11-18" }, hoy), "vencido");
  assert.equal(O.estadoDocTrabajador({ fechaVencimiento: "2026-11-19" }, hoy), "proximo");
  assert.equal(O.estadoDocTrabajador({ fechaVencimiento: "2027-01-18" }, hoy), "proximo", "60 días exactos todavía avisa");
  assert.equal(O.estadoDocTrabajador({ fechaVencimiento: "2027-01-19" }, hoy), "vigente");
  const docs = [{ id: "a", trabajadorId: "t", reemplazadoPor: "b" }, { id: "b", trabajadorId: "t", reemplazaA: "a", reemplazadoPor: "c" }, { id: "c", trabajadorId: "t", reemplazaA: "b" }, { id: "d", trabajadorId: "u" }];
  assert.deepEqual(O.docsTrabajadorActuales(docs).map((x) => x.id), ["c", "d"]);
  assert.deepEqual(O.docsTrabajadorActuales(docs, "t").map((x) => x.id), ["c"]);
  assert.deepEqual(O.historialDocTrabajador(docs[2], docs).map((x) => x.id), ["b", "a"]);
  assert.deepEqual(O.historialDocTrabajador({ id: "x", reemplazaA: "x" }, [{ id: "x", reemplazaA: "x" }]), [], "un ciclo no se recorre infinitamente");
});

test("permisos: requiere la vista Inducción y cumplimiento (riohys)", async () => {
  const lista = async (rol) => new Set((await A.rpc(base, tok[rol], "tools/list", {})).body.result.tools.map((t) => t.name));
  const prev = await lista("prevencionista");
  for (const n of ["trabajador_documentos_listar", "trabajador_documento_detalle", "trabajador_documentos_registrar", "trabajador_documento_actualizar", "trabajador_documentos_por_vencer"]) assert.ok(prev.has(n), n);
  assert.ok(!(await lista("capacitacion")).has("trabajador_documentos_listar"), "sin vista riohys no ve la carpeta");
  assert.ok(!(await lista("supervisor")).has("trabajador_documentos_registrar"));
  const lect = await lista("lectura");
  assert.ok(lect.has("trabajador_documentos_listar") && !lect.has("trabajador_documentos_registrar"), "alcance lectura oculta escrituras");
  assert.match((await H("capacitacion", "trabajador_documentos_listar", {})).texto, /no tiene acceso/);
  const con = (await H("prevencionista", "conexion_actual", {})).datos;
  assert.ok(con.modulos.find((m) => /Documentos del trabajador/.test(m.modulo)).acceso);
});

test("listar y por vencer: solo la versión actual, sin el archivo, con su estado", async () => {
  const l = (await H("prevencionista", "trabajador_documentos_listar", { trabajador_id: T6, incluir_historial: true })).datos;
  assert.equal(l.total, 4, "la licencia renovada cuenta una sola vez");
  const lic = l.resultados.find((x) => x.nombre === "Licencia de conducir A3/A5");
  assert.equal(lic.id, "td-2-andes");
  assert.equal(lic.archivo, "licencia.pdf");
  assert.equal(lic.versionesAnteriores, 1);
  assert.equal(lic.historial[0].id, "td-1-andes");
  assert.ok(!JSON.stringify(l).includes("BBBB"), "nunca devuelve el contenido del archivo");
  assert.equal(l.resultados.find((x) => x.nombre === "Contrato").estado, "No vence");
  assert.deepEqual((await H("prevencionista", "trabajador_documentos_listar", { estado: "vencido" })).datos.resultados.map((x) => x.nombre), ["Curso de manejo defensivo"]);
  assert.equal((await H("prevencionista", "trabajador_documentos_listar", { entidad: "mandante ficticio" })).datos.total, 3, "entidad sin importar mayúsculas");
  const pv = (await H("prevencionista", "trabajador_documentos_por_vencer", {})).datos;
  assert.deepEqual(pv.vencidos.map((x) => x.nombre), ["Curso de manejo defensivo"]);
  assert.deepEqual(pv.porVencer.map((x) => x.nombre), ["Examen ocupacional conductor"]);
  assert.equal(pv.porVencer[0].diasParaVencer, 25);
  assert.equal((await H("prevencionista", "trabajador_documentos_por_vencer", { dias: 10 })).datos.porVencer.length, 0);
  const det = (await H("prevencionista", "trabajador_detalle", { id: T6 })).datos;
  assert.equal(det.documentos.length, 4);
  const b = (await H("prevencionista", "buscar", { texto: "manejo defensivo" })).datos;
  assert.equal(b.documentosTrabajador.total, 1);
});

test("registrar varios a la vez (todo o nada), con nombre libre y sin vencimiento", async () => {
  const antes = await cuantos();
  // el segundo es un duplicado de un documento actual: no se guarda ninguno
  let r = await H("prevencionista", "trabajador_documentos_registrar", { documentos: [
    { trabajador_id: T1, nombre: "INIVIP", fecha_control: "2026-05-15", fecha_vencimiento: "2028-05-15" },
    { trabajador_id: T6, nombre: "  licencia de  conducir a3/a5 ", fecha_control: "2026-01-01" },
  ] });
  assert.equal(r.error, true);
  assert.match(r.texto, /ya tiene «Licencia de conducir A3\/A5» \(id td-2-andes\).*renovar_id/);
  assert.equal(await cuantos(), antes, "todo o nada");
  r = await H("prevencionista", "trabajador_documentos_registrar", { documentos: [{ trabajador_id: T1, nombre: "X", fecha_control: "2026-05-15", fecha_vencimiento: "2026-05-14" }] });
  assert.match(r.texto, /no puede ser anterior/);
  r = await H("prevencionista", "trabajador_documentos_registrar", { documentos: [{ trabajador_id: "no-existe", nombre: "X" }] });
  assert.match(r.texto, /no existe el trabajador/);
  r = await H("prevencionista", "trabajador_documentos_registrar", { documentos: [{ trabajador_id: T1, nombre: "A" }, { trabajador_id: T1, nombre: "a" }] });
  assert.match(r.texto, /viene repetido/);
  r = await H("prevencionista", "trabajador_documentos_registrar", { documentos: [{ trabajador_id: T1, nombre: "X", fecha_vencimiento: "2026-02-30" }] });
  assert.match(r.texto, /fecha AAAA-MM-DD/);
  assert.equal(await cuantos(), antes);

  r = await H("prevencionista", "trabajador_documentos_registrar", { documentos: [
    { trabajador_id: T1, nombre: "INIVIP o Evaluación Sensométrica", entidad: " ENEX ", fecha_control: "2026-05-15", fecha_vencimiento: "2028-05-15" },
    { trabajador_id: T1, nombre: "Contrato", fecha_control: "2026-05-15" },
  ] });
  assert.equal(r.error, false, r.texto);
  assert.equal(r.datos.documentos.length, 2);
  const inivip = await registro("trabajadorDocumentos", r.datos.documentos[0].id);
  assert.deepEqual({ ...inivip, id: undefined, fechaCreacion: undefined }, { id: undefined, fechaCreacion: undefined, trabajadorId: T1, nombre: "INIVIP o Evaluación Sensométrica", entidad: "ENEX", fechaControl: "2026-05-15", fechaVencimiento: "2028-05-15", observacion: "", archivoNombre: null, archivoData: null, reemplazaA: null, reemplazadoPor: null });
  assert.equal((await registro("trabajadorDocumentos", r.datos.documentos[1].id)).fechaVencimiento, null, "sin fecha de vencimiento no vence");
  assert.equal(await cuantos(), antes + 2);
  const aud = (await pool.query("SELECT herramienta, store FROM auditoria_escrituras WHERE registro_id=$1", [inivip.id])).rows;
  assert.deepEqual(aud, [{ herramienta: "trabajador_documentos_registrar", store: "trabajadorDocumentos" }]);
});

test("renovar: la versión anterior queda en el historial y no se puede renovar dos veces", async () => {
  let r = await H("prevencionista", "trabajador_documentos_registrar", { documentos: [{ trabajador_id: T6, nombre: "Curso de manejo defensivo", entidad: "Mandante Ficticio", fecha_control: "2026-08-10", fecha_vencimiento: "2028-08-10", renovar_id: "td-4-andes" }] });
  assert.equal(r.error, false, r.texto);
  const nuevo = r.datos.documentos[0];
  assert.equal(nuevo.renuevaA, "td-4-andes");
  assert.equal((await registro("trabajadorDocumentos", "td-4-andes")).reemplazadoPor, nuevo.id);
  const det = (await H("prevencionista", "trabajador_documento_detalle", { id: nuevo.id })).datos;
  assert.equal(det.esVersionActual, true);
  assert.deepEqual(det.historial.map((h) => h.id), ["td-4-andes"]);
  assert.equal((await H("prevencionista", "trabajador_documentos_por_vencer", {})).datos.vencidos.length, 0, "ya no aparece vencido");
  r = await H("prevencionista", "trabajador_documentos_registrar", { documentos: [{ trabajador_id: T6, nombre: "Curso de manejo defensivo", renovar_id: "td-4-andes" }] });
  assert.match(r.texto, /ya fue renovado; renueva la versión actual/);
  r = await H("prevencionista", "trabajador_documentos_registrar", { documentos: [{ trabajador_id: T1, nombre: "Otro", renovar_id: nuevo.id }] });
  assert.match(r.texto, /es de otro trabajador/);
  const aud = (await pool.query("SELECT operacion, campos_cambiados FROM auditoria_escrituras WHERE registro_id='td-4-andes'")).rows;
  assert.deepEqual(aud, [{ operacion: "actualizar", campos_cambiados: ["reemplazadoPor"] }], "la versión anterior solo cambia su enlace a la nueva");
});

test("actualizar: exige versión, conserva el archivo, permite vaciar el vencimiento y evita nombres duplicados", async () => {
  const det = (await H("prevencionista", "trabajador_documento_detalle", { id: "td-2-andes" })).datos;
  let r = await H("prevencionista", "trabajador_documento_actualizar", { id: "td-2-andes", version_esperada: "2000-01-01T00:00:00.000Z", observacion: "x" });
  assert.match(r.texto, /modificado por otra persona/);
  r = await H("prevencionista", "trabajador_documento_actualizar", { id: "td-2-andes", version_esperada: det._version, nombre: "Contrato" });
  assert.match(r.texto, /ya tiene otro documento llamado «Contrato»/);
  r = await H("prevencionista", "trabajador_documento_actualizar", { id: "td-2-andes", version_esperada: det._version, fecha_vencimiento: null, observacion: "Clase A3/A5 sin restricciones" });
  assert.equal(r.error, false, r.texto);
  const g = await registro("trabajadorDocumentos", "td-2-andes");
  assert.equal(g.fechaVencimiento, null);
  assert.equal(g.observacion, "Clase A3/A5 sin restricciones");
  assert.equal(g.archivoNombre, "licencia.pdf");
  assert.ok(g.archivoData.startsWith("data:application/pdf"), "el archivo subido en la app no se pierde");
  r = await H("prevencionista", "trabajador_documento_actualizar", { id: "td-2-andes", version_esperada: r.datos._version, fecha_control: "2027-01-01", fecha_vencimiento: "2026-01-01" });
  assert.match(r.texto, /no puede ser anterior/);
  const aud = (await pool.query("SELECT valor_nuevo FROM auditoria_escrituras WHERE registro_id='td-2-andes' AND herramienta='trabajador_documento_actualizar'")).rows;
  assert.equal(aud.length, 1);
  assert.equal(aud[0].valor_nuevo.archivoData.adjuntoOmitido, true, "la auditoría no copia el archivo");
});

test("aislamiento y alcance de lectura", async () => {
  assert.equal((await H("sur", "trabajador_documentos_listar", {})).datos.total, 4, "la otra empresa solo ve sus propios documentos (versión actual)");
  assert.match((await H("sur", "trabajador_documento_detalle", { id: "td-2-andes" })).texto, /No existe/);
  assert.match((await H("sur", "trabajador_documentos_registrar", { documentos: [{ trabajador_id: T6, nombre: "X" }] })).texto, /no existe el trabajador/);
  assert.match((await H("lectura", "trabajador_documentos_registrar", { documentos: [{ trabajador_id: T6, nombre: "X" }] })).texto, /solo para lectura/);
});

test("compatibilidad: la app lee el store por su API", async () => {
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: A.correo("admin"), clave: A.CLAVE }) });
  const { token } = await login.json();
  const r = await fetch(base + "/api/trabajadorDocumentos", { headers: { authorization: "Bearer " + token } });
  assert.equal(r.status, 200);
  const docs = await r.json();
  assert.ok(docs.some((d) => d.nombre === "INIVIP o Evaluación Sensométrica"));
  assert.ok(docs.every((d) => d._version === undefined));
});
