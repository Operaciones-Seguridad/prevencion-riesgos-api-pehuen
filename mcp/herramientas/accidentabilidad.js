"use strict";
// Herramientas de Accidentabilidad: accidentes, incidentes, investigación
// formal, árbol de causas e investigación de accidentes de tránsito.

const D = require("../dominio/accidentabilidad");
const { hoyIso, uid, fallar, matrizNorm } = require("../util");
const { PERMISOS } = require("../contexto");
const { esquemaPaginacion, paginar, contieneTexto, mapaPorId, resolverArea, esquemaArea, esquemaVersion, herramienta } = require("./comun");

const permiso = PERMISOS.accidentabilidad;
const CAT = D.CAT;
const IDS = { type: "array", items: { type: "string", minLength: 1 }, maxItems: 200 };
const NUM = (desc, extra) => Object.assign({ type: ["number", "null"], minimum: 0, description: desc }, extra || {});

// Catálogos con valores del rubro y de la empresa (getCatalog() en la app).
async function catalogo(datos, ctx, tipo, base) {
  const { valores } = await datos.catalogoRubro(ctx.companyId, tipo);
  const extra = ((await datos.leerUno(ctx.companyId, "catalogosExtra", tipo)) || {}).valores || [];
  const r = valores.filter((v) => !base.includes(v));
  return base.concat(r).concat(extra.filter((v) => !base.includes(v) && !r.includes(v)));
}
async function valorDeCatalogo(datos, ctx, tipo, base, valor, etiqueta) {
  if (!valor) return "";
  const lista = await catalogo(datos, ctx, tipo, base);
  const v = lista.find((x) => matrizNorm(x) === matrizNorm(valor));
  if (!v) fallar(`${etiqueta} no válido: ${valor}.`, { opciones: lista });
  return v;
}
async function validarTrabajadores(datos, ctx, ids) {
  if (!ids || !ids.length) return [];
  const t = mapaPorId(await datos.leerTodos(ctx.companyId, "trabajadores"));
  const malos = ids.filter((id) => !t[id]);
  if (malos.length) fallar(`Estos trabajadores no existen en la empresa: ${malos.join(", ")}. Usa trabajadores_listar.`);
  return [...new Set(ids)];
}

function resumenAccidente(a, ctxs) {
  const { areasPorId, trabPorId, investigaciones, arboles, transitos } = ctxs;
  const esInc = a.tipo === "incidente";
  return {
    id: a.id, fecha: a.fecha, tipo: CAT.ACC_TIPO_LABEL[a.tipo] || a.tipo, tipoClave: a.tipo, area: (areasPorId[a.areaId] || {}).nombre || "—", areaId: a.areaId,
    gravedad: esInc ? null : (D.clasificaAplica(a.tipo) ? CAT.ACC_GRAVEDAD_LABEL[a.gravedad || "leve"] : null),
    criteriosGrave: (a.criteriosGrave || []).map((k) => (CAT.ACC_CRITERIOS_GRAVE.find((c) => c.key === k) || {}).texto || k),
    diasPerdidos: a.diasPerdidos || 0, tipoIncidente: esInc ? a.tipoIncidente || "" : undefined,
    denuncia: D.denunciaSigla(a.tipo) ? { sigla: D.denunciaSigla(a.tipo), realizada: a.denunciaRealizada || "sin dato", fecha: a.fechaDenuncia || null } : null,
    trabajadores: D.trabajadoresDe(a).map((id) => (trabPorId[id] || {}).nombre || id),
    focoCritico: a.focoCritico || "", causa: a.causa || "",
    tieneInvestigacionFormal: investigaciones.some((i) => i.accidenteId === a.id),
    arbolesDeCausas: arboles.filter((x) => x.accidenteId === a.id).length,
    investigacionesTransito: transitos.filter((x) => x.accidenteId === a.id).length,
    tieneInformeAdjunto: !!a.informePreliminar, tieneFotografia: !!a.fotografia,
    _version: a._version,
  };
}
async function cargar(datos, ctx) {
  const s = await datos.leerStores(ctx.companyId, ["accidentes", "areas", "trabajadores", "accInvestigaciones", "arbolesCausales", "transitoInvestigaciones"]);
  return { s, ctxs: { areasPorId: mapaPorId(s.areas), trabPorId: mapaPorId(s.trabajadores), investigaciones: s.accInvestigaciones, arboles: s.arbolesCausales, transitos: s.transitoInvestigaciones } };
}
function resumenTransito(r, areasPorId) {
  return {
    id: r.id, fecha: r.fecha, hora: r.hora || "", area: (areasPorId[r.areaId] || {}).nombre || "—", accidenteId: r.accidenteId || null,
    tipo: CAT.TRANSITO_TIPO_LABEL[r.tipoAccidente] || r.tipoAccidente, vehiculo: r.vehiculo || "", responsable: r.responsable || "",
    fotos: (r.fotosAdicionales || []).length + (r.fotoCroquis ? 1 : 0), faltaParaCompletar: D.camposFaltantesTransito(r), _version: r._version,
  };
}

// ---- esquemas de entrada ----
const camposAccidente = {
  tipo: { type: "string", enum: D.TIPOS_ACCIDENTE, description: "ctp: con tiempo perdido; stp: sin tiempo perdido; trayecto; enfermedad (profesional). Los incidentes sin lesión van con incidente_registrar." },
  fecha: { type: "string", format: "date" },
  gravedad: { type: "string", enum: D.GRAVEDADES, description: "leve = no grave ni fatal (solo aplica a ctp, stp y trayecto)." },
  criterios_grave: { type: "array", items: { type: "string", enum: D.CRITERIOS_GRAVE }, description: "Obligatorio si gravedad=grave (Compendio SUSESO)." },
  denuncia_realizada: { type: "string", enum: ["", "si", "no"], description: "¿DIAT (accidentes) o DIEP (enfermedad) presentada?" },
  fecha_denuncia: { type: "string", format: "date" },
  dias_perdidos: { type: "integer", minimum: 0 },
  sexo: { type: "string", enum: ["", "M", "F"] },
  foco_critico: { type: "string", description: "Del catálogo de focos críticos (accidentabilidad_catalogos)." },
  causa: { type: "string", maxLength: 500 }, descripcion: { type: "string", maxLength: 5000 },
  trabajadores_ids: Object.assign({}, IDS, { description: "Trabajadores asociados (ids de trabajadores_listar)." }),
};
const camposIncidente = {
  fecha: { type: "string", format: "date" },
  tipo_incidente: { type: "string", description: "Del catálogo de tipos de incidente (accidentabilidad_catalogos)." },
  foco_critico: { type: "string" },
  danio_propiedad: { type: "boolean" }, descripcion_danio: { type: "string", maxLength: 2000 },
  trabajadores_ids: IDS, causa: { type: "string", maxLength: 500 }, descripcion: { type: "string", maxLength: 5000 },
};
const multi = (lista, desc) => ({ type: "array", items: { type: "string", enum: lista }, description: desc });
const camposInvestigacion = {
  nombre_accidentado: { type: "string", minLength: 1, maxLength: 200 }, domicilio: { type: "string", maxLength: 300 }, rut: { type: "string", maxLength: 20 },
  edad: { type: ["integer", "null"], minimum: 14, maximum: 100 }, cargo: { type: "string", maxLength: 200 }, telefono: { type: "string", maxLength: 50 },
  antiguedad_empresa: { type: "string", maxLength: 100 }, antiguedad_cargo: { type: "string", maxLength: 100 },
  hora_accidente: { type: "string", maxLength: 20 }, lugar_preciso: { type: "string", maxLength: 500 }, horas_trabajadas_hasta_accidente: { type: "string", maxLength: 50 },
  accidente_ocurrido: { type: "string", enum: ["causaTrabajo", "conOcasion"], description: "causaTrabajo: a causa del trabajo; conOcasion: con ocasión del trabajo." },
  tipo_evento: multi(CAT.INV_TIPO_EVENTO), actividad_realizada: { type: "string", maxLength: 2000 }, elemento_causo_lesion: { type: "string", maxLength: 500 },
  partes_cuerpo: multi(CAT.INV_PARTES_CUERPO), tipo_accidente: multi(CAT.INV_TIPO_ACCIDENTE),
  accion_subestandar: multi(CAT.INV_ACCION_SUBESTANDAR), condicion_subestandar: multi(CAT.INV_CONDICION_SUBESTANDAR),
  factores_personales: multi(CAT.INV_FACTORES_PERSONALES), factores_trabajo: multi(CAT.INV_FACTORES_TRABAJO),
  medidas_correctivas: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false, required: ["accion"], properties: { accion: { type: "string", minLength: 1, maxLength: 1000 }, responsable: { type: "string", maxLength: 200 }, fecha: { type: "string", format: "date" } } } },
  tiempo_reposicion_servicio: { type: "string", maxLength: 200 }, equipos_danados: { type: "string", maxLength: 1000 },
  investigador_nombre: { type: "string", maxLength: 200 }, fecha_investigacion: { type: "string", format: "date" },
  verificador_nombre: { type: "string", maxLength: 200 }, fecha_cierre: { type: "string", format: "date" },
};
const MAPA_INV = { nombre_accidentado: "nombreAccidentado", domicilio: "domicilio", rut: "rut", edad: "edad", cargo: "cargo", telefono: "telefono", antiguedad_empresa: "antiguedadEmpresa", antiguedad_cargo: "antiguedadCargo", hora_accidente: "horaAccidente", lugar_preciso: "lugarPreciso", horas_trabajadas_hasta_accidente: "horasTrabajadasHastaAccidente", accidente_ocurrido: "accidenteOcurrido", tipo_evento: "tipoEvento", actividad_realizada: "actividadRealizada", elemento_causo_lesion: "elementoCausoLesion", partes_cuerpo: "partesCuerpo", tipo_accidente: "tipoAccidente", accion_subestandar: "accionSubestandar", condicion_subestandar: "condicionSubestandar", factores_personales: "factoresPersonales", factores_trabajo: "factoresTrabajo", tiempo_reposicion_servicio: "tiempoReposicionServicio", equipos_danados: "equiposDanados", investigador_nombre: "investigadorNombre", fecha_investigacion: "fechaInvestigacion", verificador_nombre: "verificadorNombre", fecha_cierre: "fechaCierre" };
const esquemaHecho = {
  type: "object", additionalProperties: false, required: ["texto", "tipo"],
  properties: {
    ref: { type: "string", description: "Referencia corta para que otros hechos lo citen en antecede_a (p. ej. \"h1\"). Al actualizar, puedes usar el id del hecho." },
    texto: { type: "string", minLength: 1, maxLength: 1000, description: "Hecho objetivo, sin juicios." },
    tipo: { type: "string", enum: D.ARBOL_TIPOS, description: "individuo, tarea (método), material (equipo), entorno (medio) o gestion (organización)." },
    antecede_a: { type: "array", items: { type: "string" }, description: "Refs de los hechos a los que antecede, o \"central\" (por defecto)." },
    medida_correctiva: { type: "string", maxLength: 1000 }, medida_preventiva: { type: "string", maxLength: 1000 },
    plazo: { type: "string", enum: D.ARBOL_PLAZOS },
  },
};
const camposArbol = {
  hecho_central: { type: "string", minLength: 1, maxLength: 1000, description: "La lesión o daño (el hecho final del árbol)." },
  responsable: { type: "string", maxLength: 200 }, fecha_analisis: { type: "string", format: "date" },
  relato: { type: "string", maxLength: 10000 }, hechos: { type: "array", items: esquemaHecho, maxItems: 100 }, conclusion: { type: "string", maxLength: 10000 },
};
const condicion = (d) => ({ type: "string", enum: D.CONDICIONES_CALZADA, description: d });
const camposTransito = Object.assign({
  fecha: { type: "string", format: "date" }, hora: { type: "string", pattern: "^\\d{2}:\\d{2}$", description: "HH:MM" },
  accidente_id: { type: ["string", "null"], description: "Accidente registrado al que corresponde (opcional)." },
  tipo_accidente: { type: "string", enum: D.TRANSITO_TIPOS },
  vehiculo: { type: "string", maxLength: 500, description: "Vehículo(s) involucrado(s): tipo, patente, empresa." },
  responsable: { type: "string", maxLength: 200, description: "Responsable de la investigación." },
  descripcion: { type: "string", maxLength: 10000 }, participantes_ids: Object.assign({}, IDS, { description: "Trabajadores involucrados o testigos." }),
  condicion_calzada: { type: "string", enum: D.CONDICIONES_CALZADA.concat(["otro"]), description: "Fija también el coeficiente de fricción de referencia si no envías coef_friccion." },
  coef_friccion: NUM("μ de la calzada (0 a 1).", { maximum: 1 }), tipo_pendiente: { type: "string", enum: ["plana", "subida", "bajada"] }, pendiente_pct: NUM("Pendiente en %."),
  velocidad_maxima: NUM("Velocidad máxima permitida en el tramo (km/h)."),
  estado_conductor: { type: "string", enum: D.ESTADOS_CONDUCTOR, description: "Fija el tiempo de reacción sugerido si no envías tiempo_reaccion." },
  velocidad_conocida: NUM("Velocidad conocida o estimada (km/h): GPS, tacógrafo, testigo, video."),
  huella_frenado: NUM("Largo de la huella de frenado (m)."), tiempo_reaccion: NUM("Tiempo de reacción (s).", { maximum: 4 }),
  distancia_disponible: NUM("Distancia disponible para detenerse (m)."), distancia_retroceso: NUM("Distancia de retroceso (m)."),
  condicion_post_impacto: condicion("Superficie después del impacto."), coef_friccion_post_impacto: NUM("μ después del impacto.", { maximum: 1 }),
  trocha: NUM("Trocha del vehículo (m)."), altura_cg: NUM("Altura del centro de gravedad (m)."),
  masa_a: NUM("Masa del vehículo investigado (kg)."), masa_b: NUM("Masa del otro vehículo/objeto (kg)."),
  desplazamiento_b: NUM("Desplazamiento del vehículo B tras el impacto (m)."), condicion_b: condicion("Superficie bajo el vehículo B."), coef_friccion_b: NUM("μ bajo el vehículo B.", { maximum: 1 }),
  lista_verificacion: { type: "array", maxItems: 50, description: `Respuestas de la lista de verificación (${CAT.TRANSITO_CHECKLIST_ITEMS.length} ítems; ver accidentabilidad_catalogos). Indica el número de ítem (1 a ${CAT.TRANSITO_CHECKLIST_ITEMS.length}) y el estado.`,
    items: { type: "object", additionalProperties: false, required: ["item", "estado"], properties: { item: { type: "integer", minimum: 1, maximum: CAT.TRANSITO_CHECKLIST_ITEMS.length }, estado: { type: "string", enum: ["ok", "fail", "na", ""], description: "ok = Cumple, fail = No cumple, na = N/A, vacío = sin responder." } } } },
  fotos: { type: "array", maxItems: D.FOTOS_MAX_POR_LLAMADA, description: `Fotos que se AGREGAN a las existentes (no reemplazan): data URL de imagen JPG/PNG/WEBP, máx. 1,5 MB cada una y ${D.FOTOS_MAX_TOTAL} en total. Útil para cuadros de un video o fotos del lugar.`, items: { type: "string" } },
  observaciones: { type: "string", maxLength: 10000 }, conclusiones: { type: "string", maxLength: 20000 },
}, esquemaArea);
const MAPA_TRANSITO = { fecha: "fecha", hora: "hora", tipo_accidente: "tipoAccidente", vehiculo: "vehiculo", responsable: "responsable", descripcion: "descripcion", condicion_calzada: "condicionCalzada", coef_friccion: "coefFriccion", tipo_pendiente: "tipoPendiente", pendiente_pct: "pendientePct", velocidad_maxima: "velocidadMaxima", estado_conductor: "estadoConductor", velocidad_conocida: "velocidadConocida", huella_frenado: "huellaFrenado", tiempo_reaccion: "tiempoReaccion", distancia_disponible: "distanciaDisponible", distancia_retroceso: "distanciaRetroceso", condicion_post_impacto: "condicionPostImpacto", coef_friccion_post_impacto: "coefFriccionPostImpacto", trocha: "trocha", altura_cg: "alturaCg", masa_a: "masaA", masa_b: "masaB", desplazamiento_b: "desplazamientoB", condicion_b: "condicionB", coef_friccion_b: "coefFriccionB", observaciones: "observaciones", conclusiones: "conclusiones" };
const TEXTOS = new Set(["vehiculo", "responsable", "descripcion", "observaciones", "conclusiones"]);

async function aplicarTransito(datos, ctx, rec, a) {
  if (a.area_id || a.area) rec.areaId = (await resolverArea(datos, ctx, a)).id;
  if (a.accidente_id !== undefined) {
    if (a.accidente_id && !(await datos.leerUno(ctx.companyId, "accidentes", a.accidente_id))) fallar(`No existe el accidente ${a.accidente_id}. Usa accidentes_listar.`);
    rec.accidenteId = a.accidente_id || null;
  }
  for (const [k, c] of Object.entries(MAPA_TRANSITO)) {
    if (a[k] === undefined) continue;
    rec[c] = TEXTOS.has(c) ? String(a[k]).trim() : a[k];
  }
  // Mismos automatismos del formulario: al elegir una superficie se carga su μ
  // de referencia y al elegir el estado del conductor, su tiempo de reacción.
  const ref = (cond) => (CAT.COEF_FRICCION_REF[cond] || {}).mu;
  if (a.condicion_calzada !== undefined && a.coef_friccion === undefined && ref(a.condicion_calzada)) rec.coefFriccion = ref(a.condicion_calzada);
  if (a.condicion_post_impacto !== undefined && a.coef_friccion_post_impacto === undefined) rec.coefFriccionPostImpacto = ref(a.condicion_post_impacto);
  if (a.condicion_b !== undefined && a.coef_friccion_b === undefined) rec.coefFriccionB = ref(a.condicion_b);
  if (a.estado_conductor !== undefined && a.tiempo_reaccion === undefined) rec.tiempoReaccion = CAT.TRANSITO_TIEMPO_REACCION_SUGERIDO[a.estado_conductor] ?? 1;
  if (a.participantes_ids !== undefined) rec.participantesIds = await validarTrabajadores(datos, ctx, a.participantes_ids);
  if (a.lista_verificacion) {
    rec.items = CAT.TRANSITO_CHECKLIST_ITEMS.map((texto, i) => ({ texto, estado: ((rec.items || [])[i] || {}).estado || "" }));
    for (const r of a.lista_verificacion) rec.items[r.item - 1].estado = r.estado;
  }
  if (a.fotos && a.fotos.length) {
    const nuevas = a.fotos.map(D.validarFoto);
    if ((rec.fotosAdicionales || []).length + nuevas.length > D.FOTOS_MAX_TOTAL) fallar(`La investigación ya tiene ${(rec.fotosAdicionales || []).length} foto(s); el máximo es ${D.FOTOS_MAX_TOTAL}.`);
    rec.fotosAdicionales = (rec.fotosAdicionales || []).concat(nuevas);
  }
  if (!rec.fecha || !rec.areaId) fallar("Completa al menos la fecha y el área antes de guardar.");
}

module.exports = function herramientasAccidentabilidad(datos) {
  return [
    herramienta({
      name: "accidentabilidad_catalogos", title: "Accidentabilidad: catálogos", permiso,
      description: "Opciones válidas del módulo: tipos de accidente, gravedad y criterios SUSESO, focos críticos, tipos de incidente, listas de la investigación formal, tipos de hecho del árbol de causas, y para tránsito: tipos, superficies con su coeficiente de fricción, estados del conductor y la lista de verificación numerada.",
      async run(ctx) {
        return {
          tiposAccidente: CAT.ACC_TIPO_LABEL, gravedad: CAT.ACC_GRAVEDAD_LABEL, criteriosGrave: CAT.ACC_CRITERIOS_GRAVE,
          focosCriticos: await catalogo(datos, ctx, "focoCritico", []), tiposIncidente: await catalogo(datos, ctx, "tipoIncidente", CAT.INCIDENTE_TIPOS_BASE),
          investigacionFormal: { tipoEvento: CAT.INV_TIPO_EVENTO, partesCuerpo: CAT.INV_PARTES_CUERPO, tipoAccidente: CAT.INV_TIPO_ACCIDENTE, accionSubestandar: CAT.INV_ACCION_SUBESTANDAR, condicionSubestandar: CAT.INV_CONDICION_SUBESTANDAR, factoresPersonales: CAT.INV_FACTORES_PERSONALES, factoresTrabajo: CAT.INV_FACTORES_TRABAJO },
          arbolDeCausas: { tiposDeHecho: CAT.ARBOL_TIPO_LABEL, plazos: CAT.ARBOL_PLAZO_LABEL },
          transito: { tipos: CAT.TRANSITO_TIPO_LABEL, superficies: CAT.COEF_FRICCION_REF, tiempoReaccionSugerido: CAT.TRANSITO_TIEMPO_REACCION_SUGERIDO, listaVerificacion: CAT.TRANSITO_CHECKLIST_ITEMS.map((texto, i) => ({ item: i + 1, texto })) },
        };
      },
    }),
    herramienta({
      name: "accidentes_listar", title: "Accidentabilidad: listar accidentes e incidentes", permiso,
      description: "Registro de accidentes, enfermedades profesionales e incidentes, con filtros. Indica si cada uno tiene investigación formal, árbol de causas o investigación de tránsito.",
      inputSchema: { properties: Object.assign({}, esquemaArea, {
        tipo: { type: "string", enum: D.TIPOS_ACCIDENTE.concat(["incidente"]) }, gravedad: { type: "string", enum: D.GRAVEDADES },
        desde: { type: "string", format: "date" }, hasta: { type: "string", format: "date" },
        sin_investigar: { type: "boolean", description: "Solo los que no tienen investigación formal ni árbol de causas ni investigación de tránsito." },
        texto: { type: "string" },
      }, esquemaPaginacion) },
      async run(ctx, a) {
        const { s, ctxs } = await cargar(datos, ctx);
        const area = (a.area_id || a.area) ? await resolverArea(datos, ctx, a) : null;
        const lista = s.accidentes.filter((x) => (!area || x.areaId === area.id) && (!a.tipo || x.tipo === a.tipo) && (!a.gravedad || (x.gravedad || "leve") === a.gravedad)
          && (!a.desde || (x.fecha || "") >= a.desde) && (!a.hasta || (x.fecha || "") <= a.hasta)
          && contieneTexto([x.causa, x.descripcion, x.tipoIncidente], a.texto))
          .map((x) => resumenAccidente(x, ctxs))
          .filter((r) => !a.sin_investigar || (!r.tieneInvestigacionFormal && !r.arbolesDeCausas && !r.investigacionesTransito))
          .sort((x, y) => (y.fecha || "").localeCompare(x.fecha || ""));
        return paginar(lista, a);
      },
    }),
    herramienta({
      name: "accidente_detalle", title: "Accidentabilidad: detalle", permiso,
      description: "Detalle de un accidente o incidente con su investigación formal, árboles de causas e investigaciones de tránsito vinculadas (con lo que les falta para completarse). Devuelve _version de cada registro.",
      inputSchema: { required: ["id"], properties: { id: { type: "string" } } },
      async run(ctx, a) {
        const { s, ctxs } = await cargar(datos, ctx);
        const acc = s.accidentes.find((x) => x.id === a.id);
        if (!acc) fallar(`No existe el accidente/incidente ${a.id}.`);
        return {
          resumen: resumenAccidente(acc, ctxs), registro: acc,
          avisos: D.avisosClasificacion(acc.tipo, acc.gravedad || "leve"),
          investigacionFormal: s.accInvestigaciones.find((i) => i.accidenteId === acc.id) || null,
          arbolesDeCausas: s.arbolesCausales.filter((x) => x.accidenteId === acc.id),
          investigacionesTransito: s.transitoInvestigaciones.filter((x) => x.accidenteId === acc.id).map((r) => Object.assign(resumenTransito(r, ctxs.areasPorId), { calculo: D.resumenCalculoTransito(r) })),
        };
      },
    }),
    herramienta({
      name: "investigaciones_transito_listar", title: "Accidentabilidad: investigaciones de tránsito", permiso,
      description: "Investigaciones de accidentes de tránsito, con lo que le falta a cada una para quedar completa.",
      inputSchema: { properties: Object.assign({ accidente_id: { type: "string" }, solo_incompletas: { type: "boolean" } }, esquemaPaginacion) },
      async run(ctx, a) {
        const s = await datos.leerStores(ctx.companyId, ["transitoInvestigaciones", "areas"]);
        const am = mapaPorId(s.areas);
        const lista = s.transitoInvestigaciones.filter((r) => !a.accidente_id || r.accidenteId === a.accidente_id).map((r) => resumenTransito(r, am))
          .filter((r) => !a.solo_incompletas || r.faltaParaCompletar.length).sort((x, y) => (y.fecha || "").localeCompare(x.fecha || ""));
        return paginar(lista, a);
      },
    }),
    herramienta({
      name: "investigacion_transito_detalle", title: "Accidentabilidad: detalle investigación de tránsito", permiso,
      description: "Detalle completo de una investigación de tránsito: datos, lista de verificación con sus respuestas, lo que falta para completarla y el cálculo de velocidad y distancias con la física de la app. Las fotos no se descargan. Devuelve _version.",
      inputSchema: { required: ["id"], properties: { id: { type: "string" } } },
      async run(ctx, a) {
        const r = await datos.leerUno(ctx.companyId, "transitoInvestigaciones", a.id);
        if (!r) fallar(`No existe la investigación de tránsito ${a.id}.`);
        const am = mapaPorId(await datos.leerTodos(ctx.companyId, "areas"));
        return Object.assign(resumenTransito(r, am), {
          listaVerificacion: (r.items || []).map((it, i) => ({ item: i + 1, texto: it.texto, estado: D.ESTADO_CHECKLIST_LABEL[it.estado || ""] })),
          calculo: D.resumenCalculoTransito(r), registro: r,
        });
      },
    }),

    // ===================== escritura =====================
    herramienta({
      name: "accidente_registrar", title: "Accidentabilidad: registrar accidente", permiso, escritura: true,
      description: "Registra un accidente del trabajo, de trayecto o una enfermedad profesional, con las validaciones de la app: fecha y área obligatorias; si es grave, al menos un criterio SUSESO; si la DIAT/DIEP se presentó, su fecha. Devuelve los avisos legales que correspondan (suspensión y notificación inmediata). Los adjuntos se suben desde la app.",
      inputSchema: { required: ["tipo", "fecha"], properties: Object.assign({}, esquemaArea, camposAccidente) },
      async run(ctx, a) {
        const area = await resolverArea(datos, ctx, a, true);
        const rec = {
          id: uid(), tipo: a.tipo, fecha: a.fecha, areaId: area.id, trabajadoresIds: await validarTrabajadores(datos, ctx, a.trabajadores_ids),
          gravedad: a.gravedad || "leve", criteriosGrave: [...new Set(a.criterios_grave || [])], denunciaRealizada: a.denuncia_realizada || "", fechaDenuncia: a.fecha_denuncia || "",
          diasPerdidos: a.dias_perdidos || 0, sexo: a.sexo || "", focoCritico: await valorDeCatalogo(datos, ctx, "focoCritico", [], a.foco_critico, "Foco crítico"),
          causa: (a.causa || "").trim(), descripcion: (a.descripcion || "").trim(), informePreliminar: null, informePreliminarNombre: null, fotografia: null, investigado: false,
        };
        D.validarAccidente(rec);
        const { resultado } = await datos.transaccion(ctx, "accidente_registrar", (tx) => tx.guardar("accidentes", rec, null));
        return { mensaje: "Registro guardado.", id: resultado.id, avisos: D.avisosClasificacion(rec.tipo, rec.gravedad), _version: resultado._version };
      },
    }),
    herramienta({
      name: "incidente_registrar", title: "Accidentabilidad: registrar incidente", permiso, escritura: true,
      description: "Registra un incidente o cuasi accidente (sin lesión) para la pirámide de Bird: fecha, área y tipo de incidente obligatorios.",
      inputSchema: { required: ["fecha", "tipo_incidente"], properties: Object.assign({}, esquemaArea, camposIncidente) },
      async run(ctx, a) {
        const area = await resolverArea(datos, ctx, a, true);
        const rec = {
          id: uid(), gravedad: "leve", criteriosGrave: [], denunciaRealizada: "", fechaDenuncia: "", diasPerdidos: 0, sexo: "", informePreliminar: null, informePreliminarNombre: null, fotografia: null, investigado: false,
          tipo: "incidente", fecha: a.fecha, areaId: area.id, tipoIncidente: await valorDeCatalogo(datos, ctx, "tipoIncidente", CAT.INCIDENTE_TIPOS_BASE, a.tipo_incidente, "Tipo de incidente"),
          focoCritico: await valorDeCatalogo(datos, ctx, "focoCritico", [], a.foco_critico, "Foco crítico"), danioPropiedad: a.danio_propiedad ? "si" : "no", descripcionDanio: (a.descripcion_danio || "").trim(),
          trabajadoresIds: await validarTrabajadores(datos, ctx, a.trabajadores_ids), causa: (a.causa || "").trim(), descripcion: (a.descripcion || "").trim(),
        };
        D.validarIncidente(rec);
        const { resultado } = await datos.transaccion(ctx, "incidente_registrar", (tx) => tx.guardar("accidentes", rec, null));
        return { mensaje: "Incidente registrado.", id: resultado.id, _version: resultado._version };
      },
    }),
    herramienta({
      name: "accidente_actualizar", title: "Accidentabilidad: actualizar accidente o incidente", permiso, escritura: true,
      description: "Actualiza un accidente o incidente (solo los campos enviados), con las mismas validaciones del registro. Los adjuntos existentes se conservan. Requiere version_esperada (de accidente_detalle).",
      inputSchema: { required: ["id", "version_esperada"], properties: Object.assign({ id: { type: "string" }, version_esperada: esquemaVersion }, esquemaArea, camposAccidente, { tipo_incidente: camposIncidente.tipo_incidente, danio_propiedad: camposIncidente.danio_propiedad, descripcion_danio: camposIncidente.descripcion_danio }) },
      async run(ctx, a) {
        const area = (a.area_id || a.area) ? await resolverArea(datos, ctx, a) : null;
        const { resultado } = await datos.transaccion(ctx, "accidente_actualizar", async (tx) => {
          const ant = await tx.leerBloqueando("accidentes", a.id);
          if (!ant) fallar("El registro que estabas editando ya no existe.");
          tx.verificarVersion(ant, a.version_esperada);
          const rec = Object.assign({}, ant, { fechaModificacion: new Date().toISOString() });
          if (area) rec.areaId = area.id;
          if (a.fecha !== undefined) rec.fecha = a.fecha;
          if (a.trabajadores_ids !== undefined) rec.trabajadoresIds = await validarTrabajadores(datos, ctx, a.trabajadores_ids);
          if (a.causa !== undefined) rec.causa = a.causa.trim();
          if (a.descripcion !== undefined) rec.descripcion = a.descripcion.trim();
          if (a.foco_critico !== undefined) rec.focoCritico = await valorDeCatalogo(datos, ctx, "focoCritico", [], a.foco_critico, "Foco crítico");
          if (ant.tipo === "incidente") {
            if (a.tipo !== undefined) fallar("Un incidente no se puede convertir en accidente desde el conector; registra el accidente por separado.");
            if (a.tipo_incidente !== undefined) rec.tipoIncidente = await valorDeCatalogo(datos, ctx, "tipoIncidente", CAT.INCIDENTE_TIPOS_BASE, a.tipo_incidente, "Tipo de incidente");
            if (a.danio_propiedad !== undefined) rec.danioPropiedad = a.danio_propiedad ? "si" : "no";
            if (a.descripcion_danio !== undefined) rec.descripcionDanio = a.descripcion_danio.trim();
            D.validarIncidente(rec);
          } else {
            const map = { tipo: "tipo", gravedad: "gravedad", denuncia_realizada: "denunciaRealizada", fecha_denuncia: "fechaDenuncia", dias_perdidos: "diasPerdidos", sexo: "sexo" };
            for (const [k, c] of Object.entries(map)) if (a[k] !== undefined) rec[c] = a[k];
            if (a.criterios_grave !== undefined) rec.criteriosGrave = [...new Set(a.criterios_grave)];
            D.validarAccidente(rec);
          }
          return tx.guardar("accidentes", rec, ant);
        });
        return { mensaje: "Registro actualizado.", avisos: resultado.tipo === "incidente" ? [] : D.avisosClasificacion(resultado.tipo, resultado.gravedad), _version: resultado._version };
      },
    }),
    herramienta({
      name: "investigacion_accidente_guardar", title: "Accidentabilidad: investigación formal", permiso, escritura: true,
      description: "Crea o actualiza la investigación formal de un accidente (una por accidente, como en la app). El nombre del accidentado es obligatorio. Si ya existe, actualiza solo los campos enviados y exige version_esperada. Las listas (tipo de accidente, acciones y condiciones subestándar, factores) usan las opciones de accidentabilidad_catalogos. medidas_correctivas reemplaza la lista completa.",
      inputSchema: { required: ["accidente_id"], properties: Object.assign({ accidente_id: { type: "string" }, version_esperada: esquemaVersion }, camposInvestigacion) },
      async run(ctx, a) {
        const { resultado } = await datos.transaccion(ctx, "investigacion_accidente_guardar", async (tx) => {
          const acc = await tx.leerBloqueando("accidentes", a.accidente_id);
          if (!acc) fallar(`No existe el accidente ${a.accidente_id}.`);
          const existente = (await datos.leerTodos(ctx.companyId, "accInvestigaciones")).find((i) => i.accidenteId === acc.id);
          let ant = null;
          if (existente) {
            ant = await tx.leerBloqueando("accInvestigaciones", existente.id);
            if (!a.version_esperada) fallar("Este accidente ya tiene investigación formal: léela con accidente_detalle y envía su _version en version_esperada para actualizarla.");
            tx.verificarVersion(ant, a.version_esperada);
          }
          const rec = Object.assign(ant ? Object.assign({}, ant) : {
            id: uid(), accidenteId: acc.id, nombreAccidentado: "", domicilio: "", rut: "", edad: null, cargo: "", telefono: "", antiguedadEmpresa: "", antiguedadCargo: "", horaAccidente: "", lugarPreciso: "", horasTrabajadasHastaAccidente: "",
            accidenteOcurrido: "causaTrabajo", tipoEvento: [], actividadRealizada: "", elementoCausoLesion: "", partesCuerpo: [], tipoAccidente: [], accionSubestandar: [], condicionSubestandar: [], factoresPersonales: [], factoresTrabajo: [],
            medidasCorrectivas: [], tiempoReposicionServicio: "", equiposDanados: "", investigadorNombre: "", fechaInvestigacion: "", verificadorNombre: "", fechaCierre: "", fechaCreacion: new Date().toISOString(),
          }, { fechaModificacion: new Date().toISOString() });
          for (const [k, c] of Object.entries(MAPA_INV)) if (a[k] !== undefined) rec[c] = typeof a[k] === "string" ? a[k].trim() : (Array.isArray(a[k]) ? [...new Set(a[k])] : a[k]);
          if (a.medidas_correctivas !== undefined) rec.medidasCorrectivas = a.medidas_correctivas.map((m) => ({ accion: m.accion.trim(), responsable: (m.responsable || "").trim(), fecha: m.fecha || "" }));
          if (!rec.nombreAccidentado) fallar("Indica el nombre del accidentado.");
          return tx.guardar("accInvestigaciones", rec, ant);
        });
        return { mensaje: "Investigación de accidente guardada.", id: resultado.id, _version: resultado._version };
      },
    }),
    herramienta({
      name: "arbol_causas_crear", title: "Accidentabilidad: crear árbol de causas", permiso, escritura: true,
      description: "Crea un análisis de árbol de causas para un accidente o incidente: hecho central (la lesión o daño) y la lista de hechos con su tipo, a qué hecho anteceden, y sus medidas correctiva/preventiva con plazo. Cada hecho puede tener una ref (p. ej. \"h1\") para que otros lo citen en antecede_a. Avisa si hay palabras de juicio.",
      inputSchema: { required: ["accidente_id", "hecho_central"], properties: Object.assign({ accidente_id: { type: "string" } }, camposArbol) },
      async run(ctx, a) {
        if (!(await datos.leerUno(ctx.companyId, "accidentes", a.accidente_id))) fallar("Selecciona el accidente/incidente y completa el hecho central.", { detalle: `No existe ${a.accidente_id}` });
        const hechos = D.hechosArbol(a.hechos || [], uid);
        const rec = { id: uid(), accidenteId: a.accidente_id, hechoCentral: a.hecho_central.trim(), responsable: (a.responsable || "").trim(), fechaAnalisis: a.fecha_analisis || hoyIso(), relato: (a.relato || "").trim(), hechos, conclusion: (a.conclusion || "").trim() };
        const { resultado } = await datos.transaccion(ctx, "arbol_causas_crear", (tx) => tx.guardar("arbolesCausales", rec, null));
        return { mensaje: "Análisis de causa raíz guardado.", id: resultado.id, hechos: hechos.length, avisos: D.avisosJuicio(hechos.map((h) => h.texto).concat([rec.hechoCentral])), _version: resultado._version };
      },
    }),
    herramienta({
      name: "arbol_causas_actualizar", title: "Accidentabilidad: actualizar árbol de causas", permiso, escritura: true,
      description: "Actualiza un árbol de causas (solo los campos enviados). Si envías 'hechos', reemplaza la lista completa: para conservar un hecho existente usa su id como ref. Requiere version_esperada (de accidente_detalle).",
      inputSchema: { required: ["id", "version_esperada"], properties: Object.assign({ id: { type: "string" }, version_esperada: esquemaVersion }, camposArbol) },
      async run(ctx, a) {
        const { resultado } = await datos.transaccion(ctx, "arbol_causas_actualizar", async (tx) => {
          const ant = await tx.leerBloqueando("arbolesCausales", a.id);
          if (!ant) fallar("El análisis que estabas editando ya no existe.");
          tx.verificarVersion(ant, a.version_esperada);
          const rec = Object.assign({}, ant);
          if (a.hecho_central !== undefined) rec.hechoCentral = a.hecho_central.trim();
          for (const [k, c] of [["responsable", "responsable"], ["relato", "relato"], ["conclusion", "conclusion"]]) if (a[k] !== undefined) rec[c] = a[k].trim();
          if (a.fecha_analisis !== undefined) rec.fechaAnalisis = a.fecha_analisis;
          if (a.hechos !== undefined) {
            const existentes = new Set((ant.hechos || []).map((h) => h.id));
            rec.hechos = D.hechosArbol(a.hechos.map((h) => (h.ref && existentes.has(h.ref) ? Object.assign({ id: h.ref }, h) : h)), uid);
          }
          if (!rec.hechoCentral) fallar("Selecciona el accidente/incidente y completa el hecho central.");
          return tx.guardar("arbolesCausales", rec, ant);
        });
        return { mensaje: "Análisis de causa raíz actualizado.", avisos: D.avisosJuicio((resultado.hechos || []).map((h) => h.texto)), _version: resultado._version };
      },
    }),
    herramienta({
      name: "investigacion_transito_crear", title: "Accidentabilidad: crear investigación de tránsito", permiso, escritura: true,
      description: "Crea una investigación de accidente de tránsito (fecha y área obligatorias, como en la app). Al elegir la superficie se carga su coeficiente de fricción de referencia, y al elegir el estado del conductor, su tiempo de reacción sugerido. Puede recibir fotos (p. ej. cuadros de un video). Devuelve lo que falta para completarla y el cálculo de velocidad/distancias.",
      inputSchema: { required: ["fecha"], properties: camposTransito },
      async run(ctx, a) {
        const rec = D.transitoVacio(uid());
        await aplicarTransito(datos, ctx, rec, a);
        const { resultado } = await datos.transaccion(ctx, "investigacion_transito_crear", (tx) => tx.guardar("transitoInvestigaciones", rec, null));
        return { mensaje: "Investigación de tránsito guardada.", id: resultado.id, fotos: rec.fotosAdicionales.length, faltaParaCompletar: D.camposFaltantesTransito(rec), calculo: D.resumenCalculoTransito(rec), _version: resultado._version };
      },
    }),
    herramienta({
      name: "investigacion_transito_actualizar", title: "Accidentabilidad: actualizar investigación de tránsito", permiso, escritura: true,
      description: "Actualiza una investigación de tránsito (solo los campos enviados; 'lista_verificacion' cambia solo los ítems indicados; 'fotos' agrega fotos sin borrar las existentes). Requiere version_esperada (de investigacion_transito_detalle).",
      inputSchema: { required: ["id", "version_esperada"], properties: Object.assign({ id: { type: "string" }, version_esperada: esquemaVersion }, camposTransito) },
      async run(ctx, a) {
        const { resultado } = await datos.transaccion(ctx, "investigacion_transito_actualizar", async (tx) => {
          const ant = await tx.leerBloqueando("transitoInvestigaciones", a.id);
          if (!ant) fallar(`No existe la investigación de tránsito ${a.id}.`);
          tx.verificarVersion(ant, a.version_esperada);
          const rec = JSON.parse(JSON.stringify(ant));
          delete rec._version;
          await aplicarTransito(datos, ctx, rec, a);
          return tx.guardar("transitoInvestigaciones", rec, ant);
        });
        return { mensaje: "Investigación de tránsito actualizada.", fotos: (resultado.fotosAdicionales || []).length, faltaParaCompletar: D.camposFaltantesTransito(resultado), calculo: D.resumenCalculoTransito(resultado), _version: resultado._version };
      },
    }),
  ];
};
