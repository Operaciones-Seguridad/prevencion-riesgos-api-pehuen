"use strict";
// Herramientas de «Documentos del trabajador» (Inducción y cumplimiento):
// la carpeta personal de cada trabajador con documentos de nombre libre
// (licencia, INIVIP, manejo defensivo, ficha de acreditación de un
// mandante, etc.), con fecha de vencimiento opcional y renovación que
// deja la versión anterior en el historial. Los archivos se adjuntan
// desde la app; el conector registra y actualiza solo los datos.

const O = require("../dominio/otros");
const { hoyIso, uid, fallar, matrizNorm, soloFecha, diasHasta } = require("../util");
const { PERMISOS } = require("../contexto");
const { esquemaPaginacion, paginar, contieneTexto, mapaPorId, esquemaVersion, herramienta } = require("./comun");

const permiso = PERMISOS.induccion;
const ESTADOS = Object.keys(O.DOC_TRAB_ESTADO_LABEL);
const fechaONull = { type: ["string", "null"], format: "date", description: "AAAA-MM-DD, o null para dejarla vacía." };

function normTexto(s) { return String(s || "").trim().replace(/\s+/g, " "); }
function resumen(r, tm, hoy, docs) {
  const est = O.estadoDocTrabajador(r, hoy);
  const out = {
    id: r.id, trabajadorId: r.trabajadorId, trabajador: (tm[r.trabajadorId] || {}).nombre || "—",
    nombre: r.nombre, entidad: r.entidad || "", fechaControl: soloFecha(r.fechaControl), fechaVencimiento: soloFecha(r.fechaVencimiento),
    estado: O.DOC_TRAB_ESTADO_LABEL[est], observacion: r.observacion || "", archivo: r.archivoNombre || null,
  };
  if (docs) out.versionesAnteriores = O.historialDocTrabajador(r, docs).length;
  if (r.reemplazadoPor) out.reemplazadoPor = r.reemplazadoPor;
  return out;
}
function validarFechas(control, venc) {
  if (control && venc && venc < control) fallar("La fecha de vencimiento no puede ser anterior a la fecha de control o emisión.");
}

module.exports = function herramientasDocumentosTrabajador(datos) {
  return [
    herramienta({
      name: "trabajador_documentos_listar", title: "Documentos del trabajador: listar", permiso,
      description: "Documentos personales de los trabajadores (licencia, INIVIP, manejo defensivo, acreditaciones de mandantes, etc.), en su versión actual, con estado de vencimiento. Filtros por trabajador, entidad/mandante, estado y texto. Con incluir_historial=true agrega las versiones anteriores de cada uno.",
      inputSchema: { properties: Object.assign({
        trabajador_id: { type: "string" }, entidad: { type: "string" },
        estado: { type: "string", enum: ESTADOS, description: "vencido, proximo (vence en 60 días o menos), vigente o sinvenc (no vence)." },
        texto: { type: "string" }, incluir_historial: { type: "boolean" },
      }, esquemaPaginacion) },
      async run(ctx, a) {
        const s = await datos.leerStores(ctx.companyId, ["trabajadorDocumentos", "trabajadores"]);
        const tm = mapaPorId(s.trabajadores), hoy = hoyIso();
        const lista = O.docsTrabajadorActuales(s.trabajadorDocumentos, a.trabajador_id)
          .filter((r) => !a.entidad || matrizNorm(r.entidad) === matrizNorm(a.entidad))
          .filter((r) => !a.estado || O.estadoDocTrabajador(r, hoy) === a.estado)
          .filter((r) => contieneTexto([r.nombre, r.observacion, r.entidad], a.texto))
          .sort((x, y) => ((tm[x.trabajadorId] || {}).nombre || "").localeCompare((tm[y.trabajadorId] || {}).nombre || "") || (x.nombre || "").localeCompare(y.nombre || ""))
          .map((r) => {
            const out = resumen(r, tm, hoy, s.trabajadorDocumentos);
            if (a.incluir_historial) out.historial = O.historialDocTrabajador(r, s.trabajadorDocumentos).map((h) => resumen(h, tm, hoy));
            return out;
          });
        return paginar(lista, a);
      },
    }),
    herramienta({
      name: "trabajador_documento_detalle", title: "Documentos del trabajador: detalle", permiso,
      description: "Un documento del trabajador con su historial de versiones. Devuelve _version (necesaria para actualizarlo).",
      inputSchema: { required: ["id"], properties: { id: { type: "string" } } },
      async run(ctx, a) {
        const s = await datos.leerStores(ctx.companyId, ["trabajadorDocumentos", "trabajadores"]);
        const r = s.trabajadorDocumentos.find((x) => x.id === a.id);
        if (!r) fallar(`No existe el documento ${a.id}.`);
        const tm = mapaPorId(s.trabajadores), hoy = hoyIso();
        return Object.assign(resumen(r, tm, hoy), {
          esVersionActual: !r.reemplazadoPor,
          historial: O.historialDocTrabajador(r, s.trabajadorDocumentos).map((h) => resumen(h, tm, hoy)),
          _version: r._version,
        });
      },
    }),
    herramienta({
      name: "trabajador_documentos_registrar", title: "Documentos del trabajador: registrar", permiso, escritura: true,
      description: "Registra uno o varios documentos en la carpeta de trabajadores (todo o nada). El nombre es libre (p. ej. «Licencia de conducir A3/A5», «INIVIP o Evaluación Sensométrica»). Sin fecha_vencimiento, el documento no vence. Si el trabajador ya tiene un documento con el mismo nombre, se rechaza: para renovarlo indica renovar_id con el id del documento actual (la versión anterior queda en el historial). El archivo se adjunta después desde la app (Inducción y cumplimiento → Documentos del trabajador → Editar).",
      inputSchema: { required: ["documentos"], properties: {
        documentos: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["trabajador_id", "nombre"], properties: {
          trabajador_id: { type: "string" },
          nombre: { type: "string", minLength: 1, maxLength: 200 },
          entidad: { type: "string", maxLength: 120, description: "Entidad o mandante que lo exige, p. ej. ENEX (opcional)." },
          fecha_control: { type: "string", format: "date", description: "Fecha de control o emisión." },
          fecha_vencimiento: { type: "string", format: "date" },
          observacion: { type: "string", maxLength: 500 },
          renovar_id: { type: "string", description: "Id del documento actual que este renueva." },
        } } },
      } },
      async run(ctx, a) {
        const s = await datos.leerStores(ctx.companyId, ["trabajadores"]);
        const tm = mapaPorId(s.trabajadores), hoy = hoyIso();
        const { resultado } = await datos.transaccion(ctx, "trabajador_documentos_registrar", async (tx) => {
          const existentes = (await datos.leerTodos(ctx.companyId, "trabajadorDocumentos"));
          const creados = [], nuevosClaves = new Set(), renovados = new Set();
          for (const [i, d] of a.documentos.entries()) {
            const t = tm[d.trabajador_id];
            if (!t) fallar(`documentos[${i}]: no existe el trabajador ${d.trabajador_id}.`);
            const nombre = normTexto(d.nombre);
            validarFechas(d.fecha_control, d.fecha_vencimiento);
            const clave = t.id + "||" + matrizNorm(nombre);
            if (nuevosClaves.has(clave)) fallar(`documentos[${i}]: «${nombre}» de ${t.nombre} viene repetido en esta misma llamada.`);
            nuevosClaves.add(clave);
            let anterior = null;
            if (d.renovar_id) {
              if (renovados.has(d.renovar_id)) fallar(`documentos[${i}]: el documento ${d.renovar_id} ya se renueva en esta misma llamada.`);
              anterior = await tx.leerBloqueando("trabajadorDocumentos", d.renovar_id);
              if (!anterior) fallar(`documentos[${i}]: no existe el documento ${d.renovar_id} a renovar.`);
              if (anterior.trabajadorId !== t.id) fallar(`documentos[${i}]: el documento ${d.renovar_id} es de otro trabajador.`);
              if (anterior.reemplazadoPor) fallar(`documentos[${i}]: el documento ${d.renovar_id} ya fue renovado; renueva la versión actual (${anterior.reemplazadoPor}).`);
              renovados.add(d.renovar_id);
            } else {
              const dup = O.docsTrabajadorActuales(existentes, t.id).find((x) => matrizNorm(x.nombre) === matrizNorm(nombre));
              if (dup) fallar(`documentos[${i}]: ${t.nombre} ya tiene «${dup.nombre}» (id ${dup.id}). Para renovarlo, envía renovar_id: "${dup.id}".`, { documento_existente: resumen(dup, tm, hoy) });
            }
            const rec = {
              id: uid(), trabajadorId: t.id, nombre, entidad: normTexto(d.entidad),
              fechaControl: d.fecha_control || null, fechaVencimiento: d.fecha_vencimiento || null, observacion: (d.observacion || "").trim(),
              archivoNombre: null, archivoData: null, reemplazaA: anterior ? anterior.id : null, reemplazadoPor: null, fechaCreacion: new Date().toISOString(),
            };
            const g = await tx.guardar("trabajadorDocumentos", rec, null);
            if (anterior) await tx.guardar("trabajadorDocumentos", Object.assign({}, anterior, { reemplazadoPor: rec.id }), anterior);
            creados.push(Object.assign(resumen(g, tm, hoy), anterior ? { renuevaA: anterior.id } : {}));
          }
          return creados;
        });
        return { mensaje: `${resultado.length} documento(s) registrado(s). Los archivos se adjuntan desde la app (Inducción y cumplimiento → Documentos del trabajador → Editar).`, documentos: resultado };
      },
    }),
    herramienta({
      name: "trabajador_documento_actualizar", title: "Documentos del trabajador: actualizar", permiso, escritura: true,
      description: "Corrige nombre, entidad, fechas u observación de un documento (solo los campos enviados; fecha en null la deja vacía). Para registrar una versión nueva usa trabajador_documentos_registrar con renovar_id. Requiere version_esperada (de trabajador_documento_detalle).",
      inputSchema: { required: ["id", "version_esperada"], properties: {
        id: { type: "string" }, version_esperada: esquemaVersion,
        nombre: { type: "string", minLength: 1, maxLength: 200 }, entidad: { type: "string", maxLength: 120 },
        fecha_control: fechaONull, fecha_vencimiento: fechaONull, observacion: { type: "string", maxLength: 500 },
      } },
      async run(ctx, a) {
        const tm = mapaPorId(await datos.leerTodos(ctx.companyId, "trabajadores"));
        const { resultado } = await datos.transaccion(ctx, "trabajador_documento_actualizar", async (tx) => {
          const ant = await tx.leerBloqueando("trabajadorDocumentos", a.id);
          if (!ant) fallar(`No existe el documento ${a.id}.`);
          tx.verificarVersion(ant, a.version_esperada);
          const rec = Object.assign({}, ant);
          if (a.nombre !== undefined) rec.nombre = normTexto(a.nombre);
          if (a.entidad !== undefined) rec.entidad = normTexto(a.entidad);
          if (a.observacion !== undefined) rec.observacion = a.observacion.trim();
          if (a.fecha_control !== undefined) rec.fechaControl = a.fecha_control || null;
          if (a.fecha_vencimiento !== undefined) rec.fechaVencimiento = a.fecha_vencimiento || null;
          validarFechas(rec.fechaControl, rec.fechaVencimiento);
          if (!rec.reemplazadoPor && a.nombre !== undefined) {
            const otros = O.docsTrabajadorActuales(await datos.leerTodos(ctx.companyId, "trabajadorDocumentos"), rec.trabajadorId);
            const dup = otros.find((x) => x.id !== rec.id && matrizNorm(x.nombre) === matrizNorm(rec.nombre));
            if (dup) fallar(`El trabajador ya tiene otro documento llamado «${dup.nombre}» (id ${dup.id}).`);
          }
          return tx.guardar("trabajadorDocumentos", rec, ant);
        });
        return { mensaje: "Documento actualizado.", documento: resumen(resultado, tm, hoyIso()), _version: resultado._version };
      },
    }),
    herramienta({
      name: "trabajador_documentos_por_vencer", title: "Documentos del trabajador: vencidos y por vencer", permiso,
      description: "Documentos de trabajadores (versión actual) vencidos o que vencen dentro de los próximos días (por defecto 60, igual que la app). Solo considera lo registrado: no hay documentos «pendientes» por trabajador.",
      inputSchema: { properties: { dias: { type: "integer", minimum: 1, maximum: 365 }, trabajador_id: { type: "string" }, entidad: { type: "string" } } },
      async run(ctx, a) {
        const s = await datos.leerStores(ctx.companyId, ["trabajadorDocumentos", "trabajadores"]);
        const tm = mapaPorId(s.trabajadores), hoy = hoyIso(), dias = a.dias || O.DOC_TRAB_DIAS_AVISO;
        const lista = O.docsTrabajadorActuales(s.trabajadorDocumentos, a.trabajador_id)
          .filter((r) => !a.entidad || matrizNorm(r.entidad) === matrizNorm(a.entidad))
          .map((r) => ({ r, est: O.estadoDocTrabajador(r, hoy, dias) }))
          .filter((x) => x.est === "vencido" || x.est === "proximo")
          .sort((x, y) => String(soloFecha(x.r.fechaVencimiento)).localeCompare(String(soloFecha(y.r.fechaVencimiento))))
          .map((x) => Object.assign(resumen(x.r, tm, hoy), { estado: O.DOC_TRAB_ESTADO_LABEL[x.est], diasParaVencer: diasHasta(x.r.fechaVencimiento, hoy) }));
        return { ventanaDias: dias, vencidos: lista.filter((x) => x.diasParaVencer < 0), porVencer: lista.filter((x) => x.diasParaVencer >= 0) };
      },
    }),
  ];
};
