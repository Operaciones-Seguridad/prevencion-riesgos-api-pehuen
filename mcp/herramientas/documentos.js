"use strict";
// Herramientas de Control documental.

const O = require("../dominio/otros");
const M = require("../dominio/miper");
const { hoyIso, uid, fallar, normEspacios } = require("../util");
const { PERMISOS } = require("../contexto");
const { esquemaPaginacion, paginar, contieneTexto, esquemaVersion, herramienta } = require("./comun");

const permiso = PERMISOS.documentos;

function resumen(d, vigentes, hoy) {
  const vig = vigentes.get(O.documentoKey(d));
  const esVigente = !!(vig && vig.id === d.id);
  return {
    id: d.id, tipo: O.DOC_TIPOS[d.tipo] || d.tipo || "", tipoClave: d.tipo, subtipo: d.subtipo ? (O.DOC_SUBTIPOS[d.subtipo] || d.subtipo) : null,
    nombre: d.nombre, version: d.version, fechaConfeccion: d.fechaConfeccion || null, fechaRevision: d.fechaRevision || null, fechaActualizacion: d.fechaActualizacion || null,
    versionVigente: esVigente, vencimiento: esVigente ? O.vencimientoDocumento(d, hoy) : null,
    responsableElaboracion: d.responsableElaboracion || "", responsableRevision: d.responsableRevision || "", responsableAprobacion: d.responsableAprobacion || "",
    tieneArchivo: !!d.archivoData, archivoNombre: d.archivoNombre || null, _version: d._version,
  };
}
const campos = {
  tipo: { type: "string", enum: Object.keys(O.DOC_TIPOS) },
  subtipo: { type: "string", enum: Object.keys(O.DOC_SUBTIPOS), description: "Solo para tipo procedimiento (por defecto procedimiento)." },
  nombre: { type: "string", minLength: 1, maxLength: 500 },
  version: { type: "string", minLength: 1, maxLength: 50, description: "N° de versión." },
  fecha_confeccion: { type: "string", format: "date" },
  fecha_revision: { type: "string", format: "date" },
  fecha_actualizacion: { type: "string", format: "date", description: "Fecha de entrada en vigencia." },
  descripcion: { type: "string", maxLength: 5000 },
  responsable_elaboracion: { type: "string", maxLength: 200 }, responsable_revision: { type: "string", maxLength: 200 }, responsable_aprobacion: { type: "string", maxLength: 200 },
  observaciones: { type: "string", maxLength: 5000 },
  contenido: { type: "string", maxLength: 200000, description: "Contenido de texto del documento." },
};
const MAPA = { tipo: "tipo", subtipo: "subtipo", nombre: "nombre", version: "version", fecha_confeccion: "fechaConfeccion", fecha_revision: "fechaRevision", fecha_actualizacion: "fechaActualizacion", descripcion: "descripcion", responsable_elaboracion: "responsableElaboracion", responsable_revision: "responsableRevision", responsable_aprobacion: "responsableAprobacion", observaciones: "observaciones", contenido: "contenido" };
function aplicar(rec, a) {
  for (const [k, c] of Object.entries(MAPA)) if (a[k] !== undefined) rec[c] = c === "contenido" ? a[k] : String(a[k]).trim();
  // leerDocumentoDelFormulario(): subtipo solo para procedimientos
  rec.subtipo = rec.tipo === "procedimiento" ? (rec.subtipo || "procedimiento") : null;
  if (!rec.nombre) fallar("Indica el nombre del documento.");
  if (!rec.version) fallar("Indica el N° de versión del documento.");
}

module.exports = function herramientasDocumentos(datos) {
  return [
    herramienta({
      name: "documentos_listar", title: "Control documental: listar", permiso,
      description: "Documentos registrados (todas las versiones, o solo la vigente de cada uno). La versión vigente es la de fecha de actualización (o confección) más reciente entre las que tienen el mismo tipo y nombre.",
      inputSchema: { properties: Object.assign({ tipo: { type: "string", enum: Object.keys(O.DOC_TIPOS) }, solo_vigentes: { type: "boolean", description: "Por defecto sí." }, texto: { type: "string" } }, esquemaPaginacion) },
      async run(ctx, a) {
        const docs = await datos.leerTodos(ctx.companyId, "documentos"), vig = O.documentosVigentesMap(docs), hoy = hoyIso();
        const lista = docs.filter((d) => (!a.tipo || d.tipo === a.tipo) && (a.solo_vigentes === false || (vig.get(O.documentoKey(d)) || {}).id === d.id)
          && contieneTexto([d.nombre, d.descripcion, d.responsableElaboracion, d.responsableAprobacion], a.texto))
          .sort((x, y) => (x.tipo || "").localeCompare(y.tipo || "") || (x.nombre || "").localeCompare(y.nombre || "") || O.fechaVigenciaDoc(y).localeCompare(O.fechaVigenciaDoc(x)))
          .map((d) => resumen(d, vig, hoy));
        return paginar(lista, a);
      },
    }),
    herramienta({
      name: "documento_detalle", title: "Control documental: detalle", permiso,
      description: "Detalle de un documento: metadatos, contenido de texto, historial de versiones y líneas de la MIPER que lo usan como medida administrativa (D). El archivo adjunto no se descarga por el conector. Devuelve _version.",
      inputSchema: { required: ["id"], properties: { id: { type: "string" }, incluir_contenido: { type: "boolean", description: "Por defecto sí." } } },
      async run(ctx, a) {
        const docs = await datos.leerTodos(ctx.companyId, "documentos");
        const d = docs.find((x) => x.id === a.id);
        if (!d) fallar(`No existe el documento ${a.id}.`);
        const vig = O.documentosVigentesMap(docs), hoy = hoyIso(), k = O.documentoKey(d);
        const versiones = docs.filter((x) => O.documentoKey(x) === k).sort((x, y) => O.fechaVigenciaDoc(y).localeCompare(O.fechaVigenciaDoc(x)))
          .map((x) => ({ id: x.id, version: x.version, fechaActualizacion: x.fechaActualizacion || x.fechaConfeccion || null, vigente: (vig.get(k) || {}).id === x.id }));
        let lineasMiper = null;
        if (ctx.ve("matriz") && d.tipo === "procedimiento") {
          const matriz = await datos.leerTodos(ctx.companyId, "matriz");
          lineasMiper = matriz.filter((m) => M.jerarquiaDe(m).some((it) => it.jerarquia === "D" && (it.documentoId === d.id || (d.nombre && normEspacios(it.texto) === normEspacios(d.nombre)))))
            .map((m) => ({ id: m.id, linea: M.matrizLineLabel(m) }));
        }
        return Object.assign(resumen(d, vig, hoy), {
          descripcion: d.descripcion || "", observaciones: d.observaciones || "",
          contenido: a.incluir_contenido === false ? undefined : (d.contenido || ""),
          versiones, lineasMiper,
        });
      },
    }),
    herramienta({
      name: "documentos_vencidos", title: "Control documental: vencidos", permiso,
      description: "Versiones vigentes vencidas o por vencer. Criterio acordado: vencido si su fecha de revisión ya pasó; si no tiene fecha de revisión, si pasaron más de 12 meses desde su fecha de actualización (o confección). También lista los vigentes sin ninguna fecha.",
      inputSchema: { properties: { dias_aviso: { type: "integer", minimum: 0, maximum: 365, description: "Incluir los que vencen dentro de estos días (por defecto 30)." }, tipo: { type: "string", enum: Object.keys(O.DOC_TIPOS) } } },
      async run(ctx, a) {
        const docs = await datos.leerTodos(ctx.companyId, "documentos"), vig = O.documentosVigentesMap(docs), hoy = hoyIso();
        const aviso = a.dias_aviso === undefined ? 30 : a.dias_aviso;
        const vigentes = [...vig.values()].filter((d) => !a.tipo || d.tipo === a.tipo).map((d) => resumen(d, vig, hoy));
        const orden = (x, y) => (x.vencimiento.dias ?? 0) - (y.vencimiento.dias ?? 0);
        return {
          criterio: "Vencido si la fecha de revisión ya pasó; sin fecha de revisión, 12 meses desde la actualización o confección.",
          vencidos: vigentes.filter((d) => d.vencimiento.vencido).sort(orden),
          porVencer: vigentes.filter((d) => !d.vencimiento.vencido && d.vencimiento.dias !== null && d.vencimiento.dias <= aviso).sort(orden),
          sinFechas: vigentes.filter((d) => d.vencimiento.sinFechas),
          totalVigentes: vigentes.length,
        };
      },
    }),

    herramienta({
      name: "documento_crear", title: "Control documental: registrar documento", permiso, escritura: true,
      description: "Registra un documento (nombre y N° de versión obligatorios). Para una versión nueva de un documento existente, crea otro registro con el mismo tipo y nombre y una fecha de actualización más reciente: pasa a ser la vigente y la anterior queda en el historial. El archivo adjunto se sube desde la app.",
      inputSchema: { required: ["tipo", "nombre", "version"], properties: campos },
      async run(ctx, a) {
        const rec = { id: uid(), tipo: "", subtipo: null, nombre: "", version: "", fechaConfeccion: "", fechaRevision: "", fechaActualizacion: "", descripcion: "", responsableElaboracion: "", responsableRevision: "", responsableAprobacion: "", observaciones: "", contenido: "", archivoNombre: null, archivoData: null };
        aplicar(rec, a);
        const { resultado } = await datos.transaccion(ctx, "documento_crear", (tx) => tx.guardar("documentos", rec, null));
        const docs = await datos.leerTodos(ctx.companyId, "documentos");
        return { mensaje: "Documento registrado.", documento: resumen(resultado, O.documentosVigentesMap(docs), hoyIso()) };
      },
    }),
    herramienta({
      name: "documento_actualizar", title: "Control documental: actualizar documento", permiso, escritura: true,
      description: "Actualiza metadatos o contenido de un registro de documento (solo los campos enviados; el archivo adjunto se conserva). Requiere version_esperada (de documento_detalle).",
      inputSchema: { required: ["id", "version_esperada"], properties: Object.assign({ id: { type: "string" }, version_esperada: esquemaVersion }, campos) },
      async run(ctx, a) {
        const { resultado } = await datos.transaccion(ctx, "documento_actualizar", async (tx) => {
          const ant = await tx.leerBloqueando("documentos", a.id);
          if (!ant) fallar(`No existe el documento ${a.id}.`);
          tx.verificarVersion(ant, a.version_esperada);
          const rec = Object.assign({}, ant);
          aplicar(rec, a);
          return tx.guardar("documentos", rec, ant);
        });
        const docs = await datos.leerTodos(ctx.companyId, "documentos");
        return { mensaje: "Documento actualizado.", documento: resumen(resultado, O.documentosVigentesMap(docs), hoyIso()) };
      },
    }),
  ];
};
