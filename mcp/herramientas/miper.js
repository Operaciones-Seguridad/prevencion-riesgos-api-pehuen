"use strict";
// Herramientas de la Matriz de riesgos (MIPER) y su Plan de acción.

const D = require("../dominio/miper");
const CAT = require("../dominio/catalogos-app.json");
const { hoyIso, uid, matrizNorm, fallar, sumarMeses } = require("../util");
const { PERMISOS } = require("../contexto");
const { esquemaPaginacion, paginar, contieneTexto, mapaPorId, resolverArea, esquemaArea, esquemaVersion, herramienta } = require("./comun");

const permiso = PERMISOS.matriz;
const ENT15 = { type: "integer", minimum: 1, maximum: 5 };
const esquemaControl = {
  type: "object", additionalProperties: false, required: ["jerarquia", "texto"],
  properties: {
    jerarquia: { type: "string", enum: D.JERARQUIAS, description: "A Eliminación, B Sustitución, C Ingeniería, D Administrativo, E EPP." },
    texto: { type: "string", minLength: 1, maxLength: 2000 },
    responsable: { type: "string", maxLength: 200 },
    plazo: { type: "string", format: "date" },
  },
};
const camposLinea = {
  proceso: { type: "string", maxLength: 300 },
  actividad: { type: "string", maxLength: 500 },
  categoria: { type: "string", maxLength: 200 },
  peligro: { type: "string", maxLength: 500 },
  riesgo: { type: "string", maxLength: 500, description: "Riesgo asociado." },
  efecto: { type: "string", maxLength: 1000, description: "Efecto / daño probable." },
  hombres: { type: "integer", minimum: 0 }, mujeres: { type: "integer", minimum: 0 }, otros: { type: "integer", minimum: 0 },
  probabilidad: ENT15, consecuencia: ENT15,
  probabilidad_residual: Object.assign({}, ENT15, { type: ["integer", "null"], description: "Probabilidad después de los controles (null para quitarla)." }),
  consecuencia_residual: Object.assign({}, ENT15, { type: ["integer", "null"], description: "Consecuencia después de los controles (null para quitarla)." }),
  simbolo_oficial: { type: "string", enum: D.SIMBOLOS.map((s) => s.id), description: "Símbolo oficial del mapa de riesgos (ver miper_catalogos)." },
  simbolo_detalle: { type: "string", maxLength: 300, description: "Especificación para la leyenda; obligatoria en los símbolos que la requieren." },
  sensible: { type: "boolean", description: "Expone a trabajadores/as especialmente sensibles." },
  grupos_sensibles: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, description: "Obligatorio si sensible=true. Ver miper_catalogos." },
  controles: { type: "array", items: esquemaControl, maxItems: 50, description: "Medidas de control jerarquizadas (reemplaza la lista completa)." },
};

async function cargar(datos, ctx) {
  const s = await datos.leerStores(ctx.companyId, ["matriz", "planAccionMatriz", "areas"]);
  return { matriz: s.matriz, plan: s.planAccionMatriz, areas: s.areas, areasPorId: mapaPorId(s.areas) };
}
function accionResumen(p, lineasPorId, areasPorId, hoy) {
  const m = lineasPorId[p.matrizId];
  return {
    id: p.id, matrizId: p.matrizId, linea: m ? D.matrizLineLabel(m) : "(línea no encontrada)", area: m ? (areasPorId[m.areaId] || {}).nombre || "—" : "—",
    tipoAccion: D.PA_TIPO_LABEL[p.tipoAccion] || p.tipoAccion, actividad: p.actividad, responsable: p.responsable, plazo: p.plazo,
    estado: D.estadoAccionMostrado(p, hoy), ronda: p.ronda || null,
    riesgoAntes: p.probAntes ? `${D.nivelLabel(D.nivelRiesgo(p.probAntes, p.consAntes))} (${p.probAntes} x ${p.consAntes})` : null,
    riesgoDespues: p.probDespues ? `${D.nivelLabel(D.nivelRiesgo(p.probDespues, p.consDespues))} (${p.probDespues} x ${p.consDespues})` : null,
    grupoId: p.grupoId || null, _version: p._version,
  };
}
function historialItem(registroId, descripcion, campo, anterior, nuevo) { // logHistorial()
  const v = (x) => (x === undefined || x === null || x === "" ? "—" : String(x));
  return { id: uid(), registroId, descripcion, campo, anterior: v(anterior), nuevo: v(nuevo), fecha: new Date().toISOString() };
}

// Agrega al catálogo del rubro los valores escritos (addCatalogValue()).
async function registrarEnCatalogo(datos, ctx, tx, valores) {
  for (const [tipo, valor] of Object.entries(valores)) {
    const v = String(valor || "").trim();
    if (!v) continue;
    const { rubroNorm, valores: rubro } = await datos.catalogoRubro(ctx.companyId, tipo);
    const extra = ((await datos.leerUno(ctx.companyId, "catalogosExtra", tipo)) || {}).valores || [];
    const existentes = [...(CAT.CATALOG_BASE[tipo] || []), ...rubro, ...extra].map((x) => x.toLowerCase());
    if (!existentes.includes(v.toLowerCase())) await tx.agregarCatalogoRubro(rubroNorm, tipo, v);
  }
}

// Valida y arma los campos de una línea (mismas reglas que saveMatrizBtn).
function validarLinea(rec) {
  const faltan = [];
  if (!rec.areaId) faltan.push("área");
  if (!String(rec.actividad || "").trim()) faltan.push("actividad");
  if (!String(rec.peligro || "").trim()) faltan.push("peligro");
  if (!String(rec.riesgo || "").trim()) faltan.push("riesgo");
  if (faltan.length) fallar(`Complete área, actividad, peligro y riesgo (falta: ${faltan.join(", ")}).`);
  if (!rec.probabilidad || !rec.consecuencia) fallar("Indica la probabilidad y la consecuencia (1 a 5).");
  const sim = D.simboloPorId(rec.simboloOficial);
  if (!sim) fallar("Selecciona el símbolo oficial del mapa de riesgos para esta línea (norma DS N°44 / guía de mapas de riesgo). Ver miper_catalogos.");
  if (sim.requiereEspecificar && !String(rec.simboloDetalle || "").trim()) {
    fallar("Este símbolo requiere especificar el detalle que va en la leyenda del mapa de riesgos (ej: el agente higiénico, el tipo de exposición, la familia músculo-esquelética).", { sugerencias: sim.nombres });
  }
  if (!sim.requiereEspecificar) rec.simboloDetalle = "";
  if (rec.sensible && !(rec.gruposSensibles || []).length) fallar("Marcaste que este riesgo expone a trabajadores/as especialmente sensibles: indica al menos un grupo.");
  if (!rec.sensible) rec.gruposSensibles = [];
}
function aplicarControles(rec, controles, documentos) {
  const items = controles.map((c) => ({
    jerarquia: c.jerarquia, texto: c.texto.trim(), responsable: (c.responsable || "").trim(), plazo: c.plazo || "",
    documentoId: D.documentoCoincidente(c.texto, documentos),
  }));
  rec.controlesJerarquizados = items;
  rec.controles = D.controlesTextoPlano(items);
  rec.responsable = D.responsableTextoPlano(items);
  rec.plazo = D.plazoResumenControles(items);
}
function desdeArgs(args) {
  const map = { proceso: "proceso", actividad: "actividad", categoria: "categoria", peligro: "peligro", riesgo: "riesgo", efecto: "efecto", hombres: "hombres", mujeres: "mujeres", otros: "otros", probabilidad: "probabilidad", consecuencia: "consecuencia", probabilidad_residual: "probabilidadResidual", consecuencia_residual: "consecuenciaResidual", simbolo_oficial: "simboloOficial", simbolo_detalle: "simboloDetalle", sensible: "sensible", grupos_sensibles: "gruposSensibles" };
  const out = {};
  for (const [a, campo] of Object.entries(map)) {
    if (args[a] === undefined) continue;
    let v = args[a];
    if (typeof v === "string") v = v.trim();
    if (v === null) v = undefined; // residual vacío = sin evaluar, como en la app
    out[campo] = v;
  }
  return out;
}
function nivelesDe(m) {
  return { nivelPuro: D.nivelLabel(D.nivelPuroLinea(m)), nivelResidual: D.tieneResidualEvaluado(m) ? D.nivelLabel(D.nivelRiesgoLinea(m)) : "sin evaluar", nivelEfectivo: D.nivelLabel(D.nivelRiesgoLinea(m)) };
}

module.exports = function herramientasMiper(datos) {
  return [
    herramienta({
      name: "miper_catalogos", title: "MIPER: catálogos y criterios", permiso,
      description: "Opciones válidas para cargar líneas en la MIPER: símbolos oficiales del mapa de riesgos, jerarquía de controles DS 44, grupos especialmente sensibles, procesos/actividades/categorías/peligros sugeridos para el rubro de la empresa, tipos de acción del plan y la tabla de nivel de riesgo (probabilidad x consecuencia).",
      async run(ctx) {
        const sug = {};
        for (const t of ["proceso", "actividad", "categoria", "peligro"]) {
          const { valores } = await datos.catalogoRubro(ctx.companyId, t);
          sug[t] = [...new Set([...(CAT.CATALOG_BASE[t] || []), ...valores])];
        }
        return {
          simbolosOficiales: D.SIMBOLOS.map((s) => ({ id: s.id, tipo: s.tipo, familia: s.familia, nombres: s.nombres, requiereEspecificar: !!s.requiereEspecificar })),
          jerarquiaControles: CAT.JERARQUIA_DS44, gruposSensibles: D.GRUPOS_SENSIBLES, sugerencias: sug,
          tiposAccionPlan: D.PA_TIPO_LABEL,
          tablaNivelRiesgo: { descripcion: "fila = probabilidad 1..5, columna = consecuencia 1..5; 'critico' se muestra como Muy alto", tabla: D.MATRIZ_NIVEL_TABLA },
        };
      },
    }),

    herramienta({
      name: "miper_listar", title: "MIPER: listar líneas", permiso,
      description: "Lista líneas de la matriz de riesgos con filtros. El nivel efectivo es el residual si ya fue evaluado; si no, el riesgo puro (mismo criterio que la app). Ordenadas de mayor a menor riesgo.",
      inputSchema: { properties: Object.assign({}, esquemaArea, {
        proceso: { type: "string" },
        nivel: { type: "string", enum: D.NIVELES, description: "Nivel efectivo (critico = Muy alto)." },
        nivel_puro: { type: "string", enum: D.NIVELES },
        estado_tratamiento: { type: "string", enum: D.ESTADOS_TRATAMIENTO, description: "tratamiento, controlado, aceptado (Medio aceptado), por_evaluar (residual), requiere (más medidas)." },
        sensible: { type: "boolean" },
        texto: { type: "string", description: "Busca en proceso, actividad, peligro, riesgo, categoría y área." },
      }, esquemaPaginacion) },
      async run(ctx, a) {
        const { matriz, plan, areasPorId } = await cargar(datos, ctx);
        const area = (a.area_id || a.area) ? await resolverArea(datos, ctx, a) : null;
        const hoy = hoyIso();
        const lista = matriz.filter((m) => (!area || m.areaId === area.id)
          && (!a.proceso || matrizNorm(m.proceso) === matrizNorm(a.proceso))
          && (!a.nivel || D.nivelRiesgoLinea(m) === a.nivel)
          && (!a.nivel_puro || D.nivelPuroLinea(m) === a.nivel_puro)
          && (!a.estado_tratamiento || D.estadoTratamiento(m, plan, hoy).k === a.estado_tratamiento)
          && (a.sensible === undefined || !!m.sensible === a.sensible)
          && contieneTexto([m.proceso, m.actividad, m.peligro, m.riesgo, m.categoria, (areasPorId[m.areaId] || {}).nombre], a.texto))
          .sort((x, y) => D.valorOrdenRiesgoPC(D.probResidualEfectiva(y), D.consResidualEfectiva(y)) - D.valorOrdenRiesgoPC(D.probResidualEfectiva(x), D.consResidualEfectiva(x)))
          .map((m) => D.resumenLinea(m, plan, areasPorId, hoy));
        return paginar(lista, a);
      },
    }),

    herramienta({
      name: "miper_detalle", title: "MIPER: detalle de una línea", permiso,
      description: "Detalle completo de una línea: datos, niveles, medidas de control jerarquizadas, acciones del plan, aceptación de riesgo y su historial de cambios. Devuelve _version para usar en actualizaciones.",
      inputSchema: { required: ["id"], properties: { id: { type: "string" } } },
      async run(ctx, a) {
        const { matriz, plan, areasPorId } = await cargar(datos, ctx);
        const m = matriz.find((x) => x.id === a.id);
        if (!m) fallar(`No existe la línea ${a.id} en la matriz.`);
        const hoy = hoyIso();
        const historial = (await datos.leerTodos(ctx.companyId, "matrizHistorial")).filter((h) => h.registroId === m.id)
          .sort((x, y) => String(y.fecha).localeCompare(String(x.fecha))).slice(0, 50)
          .map(({ fecha, campo, anterior, nuevo }) => ({ fecha, campo, anterior, nuevo }));
        const lineasPorId = { [m.id]: m };
        return {
          linea: Object.assign({}, m, { area: (areasPorId[m.areaId] || {}).nombre || "—" }),
          niveles: nivelesDe(m),
          estadoTratamiento: D.estadoTratamiento(m, plan, hoy).label,
          controles: D.jerarquiaDe(m),
          acciones: D.accionesDe(m, plan).map((p) => accionResumen(p, lineasPorId, areasPorId, hoy)),
          aceptacionRiesgo: m.aceptacionRiesgo || null,
          historial,
        };
      },
    }),

    herramienta({
      name: "miper_riesgos_criticos", title: "MIPER: riesgos críticos", permiso,
      description: "Líneas cuyo riesgo efectivo (residual si está evaluado) es Muy alto y, opcionalmente, Alto; con su estado de tratamiento y acciones abiertas. Ordenadas de mayor a menor riesgo.",
      inputSchema: { properties: Object.assign({}, esquemaArea, { incluir_altos: { type: "boolean", description: "Incluir también las de nivel Alto (por defecto sí)." } }, esquemaPaginacion) },
      async run(ctx, a) {
        const { matriz, plan, areasPorId } = await cargar(datos, ctx);
        const area = (a.area_id || a.area) ? await resolverArea(datos, ctx, a) : null;
        const niveles = a.incluir_altos === false ? ["critico"] : ["critico", "alto"];
        const hoy = hoyIso();
        const lineasPorId = mapaPorId(matriz);
        const lista = matriz.filter((m) => (!area || m.areaId === area.id) && niveles.includes(D.nivelRiesgoLinea(m)))
          .sort((x, y) => D.valorOrdenRiesgoPC(D.probResidualEfectiva(y), D.consResidualEfectiva(y)) - D.valorOrdenRiesgoPC(D.probResidualEfectiva(x), D.consResidualEfectiva(x)))
          .map((m) => Object.assign(D.resumenLinea(m, plan, areasPorId, hoy), {
            acciones: D.accionesAbiertas(m, plan).map((p) => accionResumen(p, lineasPorId, areasPorId, hoy)),
          }));
        return paginar(lista, a);
      },
    }),

    herramienta({
      name: "miper_resumen", title: "MIPER: resumen", permiso,
      description: "Resumen de la matriz: líneas por nivel (puro y efectivo) y por área, líneas que requieren plan de acción, residual por evaluar, riesgos Medio aceptados (vencidos o por vencer en 30 días) y estado de las acciones del plan.",
      inputSchema: { properties: esquemaArea },
      async run(ctx, a) {
        const { matriz: todas, plan, areasPorId } = await cargar(datos, ctx);
        const area = (a.area_id || a.area) ? await resolverArea(datos, ctx, a) : null;
        const matriz = area ? todas.filter((m) => m.areaId === area.id) : todas;
        const hoy = hoyIso();
        const cuenta = (f) => { const o = { bajo: 0, medio: 0, alto: 0, critico: 0 }; matriz.forEach((m) => o[f(m)]++); return { Bajo: o.bajo, Medio: o.medio, Alto: o.alto, "Muy alto": o.critico }; };
        const porArea = {};
        matriz.forEach((m) => { const n = (areasPorId[m.areaId] || {}).nombre || "—"; porArea[n] = porArea[n] || { lineas: 0, altoOMuyAlto: 0 }; porArea[n].lineas++; if (["alto", "critico"].includes(D.nivelRiesgoLinea(m))) porArea[n].altoOMuyAlto++; });
        const ids = new Set(matriz.map((m) => m.id));
        const acciones = plan.filter((p) => ids.has(p.matrizId));
        const estados = { pendiente: 0, proceso: 0, cumplida: 0, atrasada: 0 };
        acciones.forEach((p) => { estados[D.estadoAccionMostrado(p, hoy)] = (estados[D.estadoAccionMostrado(p, hoy)] || 0) + 1; });
        const aceptadas = matriz.filter((m) => D.aceptacionVigente(m, hoy));
        return {
          area: area ? area.nombre : "todas", totalLineas: matriz.length,
          porNivelPuro: cuenta(D.nivelPuroLinea), porNivelEfectivo: cuenta(D.nivelRiesgoLinea),
          residualEvaluado: matriz.filter(D.tieneResidualEvaluado).length,
          requierenPlanDeAccion: matriz.filter((m) => D.requiereAccion(m, plan, hoy)).length,
          residualPorEvaluar: matriz.filter((m) => D.residualPorEvaluar(m, plan, hoy)).length,
          enTratamiento: matriz.filter((m) => D.accionesAbiertas(m, plan).length).length,
          riesgosMedioAceptados: aceptadas.length,
          aceptacionesVencidas: matriz.filter((m) => D.aceptacionVencida(m, hoy)).length,
          aceptacionesPorVencer30Dias: aceptadas.filter((m) => { const d = D.diasParaRevisionAceptacion(m, hoy); return d !== null && d <= 30; }).length,
          lineasConGruposSensibles: matriz.filter((m) => m.sensible).length,
          accionesDelPlan: Object.assign({ total: acciones.length }, estados),
          porArea,
        };
      },
    }),

    herramienta({
      name: "plan_accion_listar", title: "Plan de acción: listar acciones", permiso,
      description: "Acciones del Plan de acción de la matriz, con filtros. 'atrasada' es un estado derivado: plazo vencido y no cumplida.",
      inputSchema: { properties: Object.assign({}, esquemaArea, {
        estado: { type: "string", enum: ["pendiente", "proceso", "cumplida", "atrasada"] },
        tipo_accion: { type: "string", enum: D.PA_TIPOS },
        responsable: { type: "string" }, matriz_id: { type: "string" }, texto: { type: "string" },
      }, esquemaPaginacion) },
      async run(ctx, a) {
        const { matriz, plan, areasPorId } = await cargar(datos, ctx);
        const area = (a.area_id || a.area) ? await resolverArea(datos, ctx, a) : null;
        const lineas = mapaPorId(matriz), hoy = hoyIso();
        const lista = plan.filter((p) => {
          const m = lineas[p.matrizId];
          return (!area || (m && m.areaId === area.id)) && (!a.estado || D.estadoAccionMostrado(p, hoy) === a.estado)
            && (!a.tipo_accion || p.tipoAccion === a.tipo_accion) && (!a.matriz_id || p.matrizId === a.matriz_id)
            && (!a.responsable || matrizNorm(p.responsable).includes(matrizNorm(a.responsable)))
            && contieneTexto([p.actividad, p.responsable, m && m.peligro, m && m.riesgo, m && m.actividad], a.texto);
        }).sort((x, y) => (x.plazo || "").localeCompare(y.plazo || "")).map((p) => accionResumen(p, lineas, areasPorId, hoy));
        return paginar(lista, a);
      },
    }),

    // ===================== escritura =====================
    herramienta({
      name: "miper_crear_linea", title: "MIPER: crear línea", permiso, escritura: true,
      description: "Agrega una línea a la matriz de riesgos con las mismas validaciones que la app: área, actividad, peligro, riesgo, probabilidad, consecuencia y símbolo oficial obligatorios. Registra la creación en el historial de la matriz.",
      inputSchema: { required: ["actividad", "peligro", "riesgo", "probabilidad", "consecuencia", "simbolo_oficial"], properties: Object.assign({}, esquemaArea, camposLinea) },
      async run(ctx, a) {
        const area = await resolverArea(datos, ctx, a, true);
        const documentos = await datos.leerTodos(ctx.companyId, "documentos");
        const rec = Object.assign({ id: uid(), areaId: area.id, proceso: "", categoria: "", efecto: "", hombres: 0, mujeres: 0, otros: 0, sensible: false, gruposSensibles: [], simboloDetalle: "" }, desdeArgs(a));
        validarLinea(rec);
        aplicarControles(rec, a.controles || [], documentos);
        Object.assign(rec, { estado: "pendiente", revisado: false, fechaRevision: "", fechaCreacion: new Date().toISOString() });
        const { resultado } = await datos.transaccion(ctx, "miper_crear_linea", async (tx) => {
          await registrarEnCatalogo(datos, ctx, tx, { proceso: rec.proceso, actividad: rec.actividad, categoria: rec.categoria, peligro: rec.peligro });
          const g = await tx.guardar("matriz", rec, null);
          await tx.guardar("matrizHistorial", historialItem(rec.id, D.matrizLineLabel(rec), "Línea creada", "", "Creada"), null);
          return g;
        });
        return { mensaje: "Línea agregada a la matriz de riesgos.", linea: D.resumenLinea(resultado, [], { [area.id]: area }, hoyIso()), niveles: nivelesDe(resultado) };
      },
    }),

    herramienta({
      name: "miper_actualizar_linea", title: "MIPER: actualizar línea", permiso, escritura: true,
      description: "Actualiza campos de una línea existente (solo los que envíes). Si envías 'controles', reemplaza la lista completa de medidas. Registra en el historial de la matriz cada campo que cambió, igual que la app. Requiere version_esperada (de miper_detalle).",
      inputSchema: { required: ["id", "version_esperada"], properties: Object.assign({ id: { type: "string" }, version_esperada: esquemaVersion }, esquemaArea, camposLinea) },
      async run(ctx, a) {
        const area = (a.area_id || a.area) ? await resolverArea(datos, ctx, a) : null;
        const documentos = await datos.leerTodos(ctx.companyId, "documentos");
        const { resultado } = await datos.transaccion(ctx, "miper_actualizar_linea", async (tx) => {
          const anterior = await tx.leerBloqueando("matriz", a.id);
          if (!anterior) fallar(`No existe la línea ${a.id} en la matriz.`);
          tx.verificarVersion(anterior, a.version_esperada);
          const rec = Object.assign({}, anterior, desdeArgs(a));
          if (area) rec.areaId = area.id;
          if (!D.simboloPorId(rec.simboloOficial) && a.simbolo_oficial === undefined) fallar("Esta línea no tiene símbolo oficial: envía simbolo_oficial (la app también lo exige al guardar).");
          validarLinea(rec);
          if (a.controles) aplicarControles(rec, a.controles, documentos);
          const label = D.matrizLineLabel(rec), historial = [];
          if (String(!!anterior.sensible) !== String(!!rec.sensible) || JSON.stringify(anterior.gruposSensibles || []) !== JSON.stringify(rec.gruposSensibles || [])) {
            historial.push(historialItem(rec.id, label, "Especialmente sensible", anterior.sensible ? (anterior.gruposSensibles || []).join(", ") : "No", rec.sensible ? (rec.gruposSensibles || []).join(", ") : "No"));
          }
          const CAMPOS = [["areaId", "Área"], ["proceso", "Proceso"], ["actividad", "Actividad"], ["categoria", "Categoría"], ["peligro", "Peligro"], ["riesgo", "Riesgo asociado"], ["probabilidad", "Probabilidad"], ["consecuencia", "Consecuencia"], ["probabilidadResidual", "Probabilidad residual"], ["consecuenciaResidual", "Consecuencia residual"], ["hombres", "N° hombres"], ["mujeres", "N° mujeres"], ["otros", "N° otros"], ["simboloOficial", "Símbolo oficial (mapa de riesgos)"], ["simboloDetalle", "Especificación de la leyenda"]];
          for (const [campo, etiqueta] of CAMPOS) {
            if (String(anterior[campo] ?? "") !== String(rec[campo] ?? "")) historial.push(historialItem(rec.id, label, etiqueta, anterior[campo], rec[campo]));
          }
          if (a.controles && JSON.stringify(D.jerarquiaDe(anterior)) !== JSON.stringify(rec.controlesJerarquizados)) {
            historial.push(historialItem(rec.id, label, "Medidas de control (jerarquía DS 44)", "", "Modificadas"));
          }
          await registrarEnCatalogo(datos, ctx, tx, { proceso: rec.proceso, actividad: rec.actividad, categoria: rec.categoria, peligro: rec.peligro });
          const g = await tx.guardar("matriz", rec, anterior);
          for (const h of historial) await tx.guardar("matrizHistorial", h, null);
          return { g, cambios: historial.map((h) => h.campo) };
        });
        return { mensaje: resultado.cambios.length ? "Línea de la matriz de riesgos actualizada." : "No hubo cambios en los campos registrados en el historial.", camposCambiados: resultado.cambios, niveles: nivelesDe(resultado.g), _version: resultado.g._version };
      },
    }),

    herramienta({
      name: "miper_reasignar_area", title: "MIPER: cambiar el área de varias líneas", permiso, escritura: true,
      description: "Mueve hasta 300 líneas de la matriz a un área, en una sola operación (solo cambia el área; el resto de la línea queda igual). Registra el cambio de área en el historial de cada línea y en la auditoría. Las líneas que ya están en esa área se omiten. Si algún id no existe, no se cambia ninguna.",
      inputSchema: { required: ["ids"], properties: Object.assign({}, esquemaArea, {
        ids: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 300, description: "Ids de las líneas (ver miper_listar)." },
      }) },
      async run(ctx, a) {
        const area = await resolverArea(datos, ctx, a, true);
        const ids = [...new Set(a.ids)];
        const { resultado } = await datos.transaccion(ctx, "miper_reasignar_area", async (tx) => {
          const anteriores = [];
          for (const id of ids) {
            const anterior = await tx.leerBloqueando("matriz", id);
            if (!anterior) fallar(`No existe la línea ${id} en la matriz; no se cambió ninguna.`);
            anteriores.push(anterior);
          }
          let movidas = 0;
          for (const anterior of anteriores) {
            if (anterior.areaId === area.id) continue;
            const rec = Object.assign({}, anterior, { areaId: area.id });
            await tx.guardar("matriz", rec, anterior);
            await tx.guardar("matrizHistorial", historialItem(rec.id, D.matrizLineLabel(rec), "Área", anterior.areaId, area.id), null);
            movidas++;
          }
          return { movidas, omitidas: anteriores.length - movidas };
        });
        return { mensaje: `${resultado.movidas} línea(s) movidas al área «${area.nombre}».`, movidas: resultado.movidas, yaEstabanEnEsaArea: resultado.omitidas, area: { id: area.id, nombre: area.nombre } };
      },
    }),

    herramienta({
      name: "plan_accion_crear", title: "Plan de acción: crear acción", permiso, escritura: true,
      description: "Crea una acción del Plan de acción para una línea de riesgo Medio o superior (y opcionalmente para otras líneas, con un grupo compartido; cada línea conserva su propio seguimiento). Actividad, responsable y plazo son obligatorios.",
      inputSchema: { required: ["matriz_id", "actividad", "responsable", "plazo"], properties: {
        matriz_id: { type: "string" },
        otras_lineas: { type: "array", items: { type: "string" }, maxItems: 200, description: "Ids de otras líneas a las que aplicar la misma acción." },
        tipo_accion: { type: "string", enum: D.PA_TIPOS, description: "Por defecto mitigar." },
        actividad: { type: "string", minLength: 1, maxLength: 2000 }, responsable: { type: "string", minLength: 1, maxLength: 200 },
        plazo: { type: "string", format: "date", description: "Plazo de ejecución." },
        controles_validados: { type: "boolean" }, observacion_validacion: { type: "string", maxLength: 2000 },
        presupuesto: { type: ["number", "null"], minimum: 0 }, recursos: { type: "string", maxLength: 2000 },
        proxima_revision: { type: "string", format: "date" },
      } },
      async run(ctx, a) {
        const comunes = {
          controlesValidados: !!a.controles_validados, observacionValidacion: (a.observacion_validacion || "").trim(),
          tipoAccion: a.tipo_accion || "mitigar", actividad: a.actividad.trim(), plazo: a.plazo, responsable: a.responsable.trim(),
          presupuesto: a.presupuesto === undefined ? null : a.presupuesto, recursos: (a.recursos || "").trim(), proximaRevision: a.proxima_revision || "",
        };
        const { resultado } = await datos.transaccion(ctx, "plan_accion_crear", async (tx) => {
          const plan = await datos.leerTodos(ctx.companyId, "planAccionMatriz");
          const ids = [a.matriz_id].concat((a.otras_lineas || []).filter((id) => id !== a.matriz_id));
          const lineas = [];
          for (const id of [...new Set(ids)]) {
            const m = await tx.leerBloqueando("matriz", id);
            if (!m) fallar(`No existe la línea ${id} en la matriz.`);
            if (D.nivelRiesgoLinea(m) === "bajo") fallar(`La línea "${D.matrizLineLabel(m)}" tiene riesgo Bajo: el plan de acción es para líneas de riesgo medio, alto o muy alto.`);
            lineas.push(m);
          }
          const grupoId = lineas.length > 1 ? uid() : null, creadas = [];
          for (const m of lineas) {
            const rec = Object.assign({ id: uid(), matrizId: m.id }, comunes, {
              estado: "pendiente", ronda: D.accionesDe(m, plan).length + 1, probAntes: D.probResidualEfectiva(m), consAntes: D.consResidualEfectiva(m),
              probDespues: null, consDespues: null, eficaciaObservacion: "", fechaCreacion: new Date().toISOString(),
            });
            if (grupoId) rec.grupoId = grupoId;
            creadas.push(await tx.guardar("planAccionMatriz", rec, null));
            await tx.guardar("matrizHistorial", historialItem(m.id, D.matrizLineLabel(m), "Plan de acción", "", `Creada: ${D.PA_TIPO_LABEL[rec.tipoAccion]} — ${rec.actividad}${grupoId ? ` (aplicada a ${lineas.length} líneas)` : ""}`), null);
          }
          return creadas;
        });
        return { mensaje: resultado.length > 1 ? `Acción agregada al plan para ${resultado.length} líneas.` : "Acción agregada al plan.", acciones: resultado.map((p) => ({ id: p.id, matrizId: p.matrizId, ronda: p.ronda, _version: p._version })) };
      },
    }),

    herramienta({
      name: "plan_accion_actualizar", title: "Plan de acción: actualizar acción", permiso, escritura: true,
      description: "Actualiza los datos de una acción (no su estado: usa plan_accion_cambiar_estado o plan_accion_marcar_cumplida). Con aplicar_al_grupo=true también actualiza las otras acciones de su mismo grupo, como la app.",
      inputSchema: { required: ["id", "version_esperada"], properties: {
        id: { type: "string" }, version_esperada: esquemaVersion, aplicar_al_grupo: { type: "boolean" },
        tipo_accion: { type: "string", enum: D.PA_TIPOS }, actividad: { type: "string", minLength: 1, maxLength: 2000 }, responsable: { type: "string", minLength: 1, maxLength: 200 },
        plazo: { type: "string", format: "date" }, controles_validados: { type: "boolean" }, observacion_validacion: { type: "string", maxLength: 2000 },
        presupuesto: { type: ["number", "null"], minimum: 0 }, recursos: { type: "string", maxLength: 2000 }, proxima_revision: { type: "string", format: "date" },
      } },
      async run(ctx, a) {
        const { resultado } = await datos.transaccion(ctx, "plan_accion_actualizar", async (tx) => {
          const anterior = await tx.leerBloqueando("planAccionMatriz", a.id);
          if (!anterior) fallar(`No existe la acción ${a.id}.`);
          tx.verificarVersion(anterior, a.version_esperada);
          const cambios = {};
          const map = { tipo_accion: "tipoAccion", actividad: "actividad", responsable: "responsable", plazo: "plazo", controles_validados: "controlesValidados", observacion_validacion: "observacionValidacion", presupuesto: "presupuesto", recursos: "recursos", proxima_revision: "proximaRevision" };
          for (const [k, c] of Object.entries(map)) if (a[k] !== undefined) cambios[c] = typeof a[k] === "string" ? a[k].trim() : a[k];
          const rec = Object.assign({}, anterior, cambios);
          if (!rec.actividad || !rec.responsable || !rec.plazo) fallar("Completa actividad, responsable y plazo de ejecución.");
          const m = await tx.leerBloqueando("matriz", rec.matrizId);
          const g = await tx.guardar("planAccionMatriz", rec, anterior);
          await tx.guardar("matrizHistorial", historialItem(rec.matrizId, m ? D.matrizLineLabel(m) : rec.matrizId, "Plan de acción", "", `Editada: ${D.PA_TIPO_LABEL[rec.tipoAccion]} — ${rec.actividad}`), null);
          let otras = 0;
          if (a.aplicar_al_grupo && anterior.grupoId) {
            const delGrupo = (await datos.leerTodos(ctx.companyId, "planAccionMatriz")).filter((x) => x.grupoId === anterior.grupoId && x.id !== anterior.id);
            for (const o0 of delGrupo) {
              const o = await tx.leerBloqueando("planAccionMatriz", o0.id);
              await tx.guardar("planAccionMatriz", Object.assign({}, o, cambios), o);
              const ml = await tx.leerBloqueando("matriz", o.matrizId);
              await tx.guardar("matrizHistorial", historialItem(o.matrizId, ml ? D.matrizLineLabel(ml) : o.matrizId, "Plan de acción", "", `Editada con su grupo: ${D.PA_TIPO_LABEL[rec.tipoAccion]} — ${rec.actividad}`), null);
              otras++;
            }
          }
          return { g, otras };
        });
        return { mensaje: resultado.otras ? `Acción actualizada, junto con otras ${resultado.otras} del mismo grupo.` : "Acción actualizada.", _version: resultado.g._version };
      },
    }),

    herramienta({
      name: "plan_accion_cambiar_estado", title: "Plan de acción: cambiar estado", permiso, escritura: true,
      description: "Cambia el estado de una o más acciones a Pendiente o En proceso. Para marcarlas cumplidas usa plan_accion_marcar_cumplida (exige reevaluar el riesgo residual).",
      inputSchema: { required: ["ids", "estado"], properties: { ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 }, estado: { type: "string", enum: ["pendiente", "proceso"] } } },
      async run(ctx, a) {
        const { resultado } = await datos.transaccion(ctx, "plan_accion_cambiar_estado", async (tx) => {
          let n = 0;
          for (const id of [...new Set(a.ids)]) {
            const p = await tx.leerBloqueando("planAccionMatriz", id);
            if (!p) fallar(`No existe la acción ${id}.`);
            if (p.estado === a.estado) continue;
            await tx.guardar("planAccionMatriz", Object.assign({}, p, { estado: a.estado }), p);
            const m = await tx.leerBloqueando("matriz", p.matrizId);
            await tx.guardar("matrizHistorial", historialItem(p.matrizId, m ? D.matrizLineLabel(m) : p.matrizId, "Estado del plan de acción", p.estado, a.estado), null);
            n++;
          }
          return n;
        });
        return { mensaje: `Estado actualizado en ${resultado} acción(es).` };
      },
    }),

    herramienta({
      name: "plan_accion_marcar_cumplida", title: "Plan de acción: marcar cumplida", permiso, escritura: true,
      description: "Marca acciones como cumplidas y reevalúa el riesgo residual: la probabilidad y consecuencia posteriores se guardan en la línea de la matriz (y revocan una aceptación de riesgo vigente). Bajo = controlada; Medio = nueva acción o aceptación justificada; Alto/Muy alto = obliga a una nueva ronda de acciones.",
      inputSchema: { required: ["ids", "probabilidad_despues", "consecuencia_despues"], properties: {
        ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
        probabilidad_despues: ENT15, consecuencia_despues: ENT15,
        fecha: { type: "string", format: "date", description: "Fecha de cumplimiento (por defecto hoy)." },
        observacion: { type: "string", maxLength: 2000, description: "Observación sobre la eficacia." },
      } },
      async run(ctx, a) {
        const prob = a.probabilidad_despues, cons = a.consecuencia_despues, fecha = a.fecha || hoyIso(), obs = (a.observacion || "").trim();
        const nivel = D.nivelRiesgo(prob, cons);
        const { resultado } = await datos.transaccion(ctx, "plan_accion_marcar_cumplida", async (tx) => {
          const lineas = new Set();
          for (const id of [...new Set(a.ids)]) {
            const p = await tx.leerBloqueando("planAccionMatriz", id);
            if (!p) fallar(`No existe la acción ${id}.`);
            if (p.estado === "cumplida") fallar(`La acción "${p.actividad}" ya está cumplida.`);
            await tx.guardar("planAccionMatriz", Object.assign({}, p, { estado: "cumplida", fechaCumplida: fecha, probDespues: prob, consDespues: cons, eficaciaObservacion: obs }), p);
            const m = await tx.leerBloqueando("matriz", p.matrizId);
            if (m) {
              const antes = D.nivelLabel(D.nivelRiesgoLinea(m));
              const rec = Object.assign({}, m, { probabilidadResidual: prob, consecuenciaResidual: cons });
              if (rec.aceptacionRiesgo && !rec.aceptacionRiesgo.revocada) rec.aceptacionRiesgo = Object.assign({}, rec.aceptacionRiesgo, { revocada: true, revocadaMotivo: "Nueva evaluación del riesgo residual" });
              await tx.guardar("matriz", rec, m);
              const label = D.matrizLineLabel(m);
              await tx.guardar("matrizHistorial", historialItem(p.matrizId, label, "Estado del plan de acción", p.estado, "cumplida"), null);
              await tx.guardar("matrizHistorial", historialItem(p.matrizId, label, "Riesgo residual (acción cumplida)", antes, `${D.nivelLabel(nivel)} (${prob} x ${cons})${obs ? " — " + obs : ""}`), null);
              lineas.add(p.matrizId);
            }
          }
          return [...lineas];
        });
        const siguiente = nivel === "bajo" ? "El riesgo quedó controlado (Bajo)." : nivel === "medio" ? "El riesgo quedó Medio: requiere una nueva acción o una aceptación justificada (miper_aceptar_riesgo_medio, solo perfiles con ese permiso)." : `El riesgo sigue ${D.nivelLabel(nivel)}: obliga a una nueva ronda de acciones.`;
        return { mensaje: `${a.ids.length} acción(es) marcada(s) como cumplida(s).`, riesgoResidual: `${D.nivelLabel(nivel)} (${prob} x ${cons})`, siguientePaso: siguiente, lineasActualizadas: resultado };
      },
    }),

    herramienta({
      name: "miper_aceptar_riesgo_medio", title: "MIPER: aceptar riesgo Medio", permiso: (c) => permiso(c) && c.puedeAceptarRiesgos, escritura: true,
      description: "Acepta con justificación un riesgo que quedó en nivel Medio después de los controles. Solo para perfiles con permiso para aceptar riesgos (Prevencionista). Queda registrado quién lo aceptó y cuándo debe revisarse.",
      inputSchema: { required: ["matriz_id", "justificacion"], properties: {
        matriz_id: { type: "string" }, justificacion: { type: "string", minLength: 1, maxLength: 3000 },
        revisar_en: { type: "string", format: "date", description: "Fecha de revisión, posterior a hoy (por defecto en un año)." },
      } },
      async run(ctx, a) {
        const hoy = hoyIso(), revisarEn = a.revisar_en || sumarMeses(hoy, 12);
        if (revisarEn <= hoy) fallar("Indica una fecha de revisión posterior a hoy.");
        const { resultado } = await datos.transaccion(ctx, "miper_aceptar_riesgo_medio", async (tx) => {
          const m = await tx.leerBloqueando("matriz", a.matriz_id);
          if (!m) fallar(`No existe la línea ${a.matriz_id} en la matriz.`);
          if (D.nivelRiesgoLinea(m) !== "medio") fallar("Solo se puede aceptar un riesgo que quedó en nivel Medio.");
          const just = a.justificacion.trim();
          const rec = Object.assign({}, m, { aceptacionRiesgo: { fecha: hoy, por: ctx.usuario.nombre || "Prevencionista", justificacion: just, revisarEn, nivel: "medio", controlesAplicados: D.jerarquiaDe(m).length, revocada: false } });
          const g = await tx.guardar("matriz", rec, m);
          await tx.guardar("matrizHistorial", historialItem(m.id, D.matrizLineLabel(m), "Riesgo Medio aceptado", "", `Por ${ctx.usuario.nombre || "Prevencionista"} — ${just} (revisión ${revisarEn})`), null);
          return g;
        });
        return { mensaje: "Riesgo Medio aceptado.", aceptacionRiesgo: resultado.aceptacionRiesgo, _version: resultado._version };
      },
    }),

    herramienta({
      name: "miper_revocar_aceptacion", title: "MIPER: revocar aceptación de riesgo", permiso: (c) => permiso(c) && c.puedeAceptarRiesgos, escritura: true,
      description: "Revoca la aceptación de un riesgo Medio; la línea vuelve a 'Pendientes de plan de acción'. Solo para perfiles con permiso para aceptar riesgos.",
      inputSchema: { required: ["matriz_id"], properties: { matriz_id: { type: "string" } } },
      async run(ctx, a) {
        await datos.transaccion(ctx, "miper_revocar_aceptacion", async (tx) => {
          const m = await tx.leerBloqueando("matriz", a.matriz_id);
          if (!m) fallar(`No existe la línea ${a.matriz_id} en la matriz.`);
          if (!m.aceptacionRiesgo || m.aceptacionRiesgo.revocada) fallar("Esta línea no tiene una aceptación de riesgo vigente.");
          await tx.guardar("matriz", Object.assign({}, m, { aceptacionRiesgo: Object.assign({}, m.aceptacionRiesgo, { revocada: true, revocadaMotivo: "Revocada manualmente" }) }), m);
          await tx.guardar("matrizHistorial", historialItem(m.id, D.matrizLineLabel(m), "Riesgo Medio aceptado", "Aceptado", "Revocada"), null);
        });
        return { mensaje: "Aceptación revocada. La línea vuelve a 'Pendientes de plan de acción'." };
      },
    }),
  ];
};
