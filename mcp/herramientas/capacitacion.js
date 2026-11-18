"use strict";
// Herramientas de Capacitación: plan de capacitaciones y cursos obligatorios.

const O = require("../dominio/otros");
const { hoyIso, uid, fallar, diasHasta, soloFecha, matrizNorm } = require("../util");
const { PERMISOS } = require("../contexto");
const { esquemaPaginacion, paginar, contieneTexto, mapaPorId, esquemaVersion, herramienta } = require("./comun");

const permiso = PERMISOS.capacitacion;
const esquemaDirigida = {
  type: "object", additionalProperties: false, required: ["tipo"],
  description: "A quién va dirigida: ninguno (sin definir), todos, cargos (lista de cargos) o personas (ids de trabajadores). Define los convocados.",
  properties: {
    tipo: { type: "string", enum: ["ninguno", "todos", "cargos", "personas"] },
    cargos: { type: "array", items: { type: "string", minLength: 1 } },
    personas_ids: { type: "array", items: { type: "string", minLength: 1 } },
  },
};
function resumen(c, trabPorId) {
  const cum = O.cumplimientoCapacitacion(c);
  return {
    id: c.id, nombre: c.nombre, tipo: c.tipo || "", fechaProgramada: c.fechaProgramada || null, fechaRealizada: c.fechaRealizada || null,
    estado: O.estadoCapacitacion(c), horas: c.horas || 0, relator: c.relator || "", documentoId: c.documentoId || null,
    dirigidaA: c.dirigidaA || { tipo: "ninguno" }, convocados: cum.convocados, asistieron: cum.asistieron, aprobados: cum.aprobados, porcentajeAsistencia: cum.porcentaje,
    tieneRegistroAdjunto: !!c.documento, _version: c._version,
    ...(trabPorId ? { participantes: (c.participantes || []).map((p) => ({ trabajadorId: p.trabajadorId, nombre: (trabPorId[p.trabajadorId] || {}).nombre || "—", asistio: !!p.asistio, aprobado: !!p.aprobado })) } : {}),
  };
}
async function tiposValidos(datos, ctx) {
  const { valores } = await datos.catalogoRubro(ctx.companyId, "capTipo");
  const extra = ((await datos.leerUno(ctx.companyId, "catalogosExtra", "capTipo")) || {}).valores || [];
  return O.tiposCapacitacion(valores, extra);
}
function leerDirigida(d, trabajadores) {
  const dir = { tipo: d.tipo, cargos: d.tipo === "cargos" ? (d.cargos || []).map((s) => s.trim()) : [], personasIds: d.tipo === "personas" ? (d.personas_ids || []) : [] };
  if (dir.tipo === "cargos" && !dir.cargos.length) fallar('Marca al menos un cargo, o elige otra opción en "Dirigida a".');
  if (dir.tipo === "personas" && !dir.personasIds.length) fallar('Agrega al menos una persona, o elige otra opción en "Dirigida a".');
  const noExisten = dir.personasIds.filter((id) => !trabajadores.some((t) => t.id === id));
  if (noExisten.length) fallar(`Estos trabajadores no existen en la empresa: ${noExisten.join(", ")}`);
  return dir;
}
const campos = {
  nombre: { type: "string", minLength: 1, maxLength: 500 },
  tipo: { type: "string", description: "Tipo de capacitación del catálogo (ver capacitaciones_catalogos)." },
  fecha_programada: { type: "string", format: "date" },
  horas: { type: "number", minimum: 0 },
  relator: { type: "string", maxLength: 200 },
  documento_id: { type: ["string", "null"], description: "Procedimiento/documento asociado (id de Control documental)." },
  dirigida_a: esquemaDirigida,
};
async function aplicarCampos(datos, ctx, rec, a, trabajadores, { recalcularRealizada = true } = {}) {
  if (a.nombre !== undefined) rec.nombre = a.nombre.trim();
  if (a.tipo !== undefined) {
    const tipos = await tiposValidos(datos, ctx);
    const t = tipos.find((x) => matrizNorm(x) === matrizNorm(a.tipo));
    if (!t) fallar(`Tipo de capacitación no válido: ${a.tipo}.`, { tipos_validos: tipos });
    rec.tipo = t;
  }
  if (a.fecha_programada !== undefined) rec.fechaProgramada = a.fecha_programada;
  if (a.horas !== undefined) rec.horas = a.horas;
  if (a.relator !== undefined) rec.relator = a.relator.trim();
  if (a.documento_id !== undefined) {
    if (a.documento_id && !(await datos.leerUno(ctx.companyId, "documentos", a.documento_id))) fallar(`No existe el documento ${a.documento_id} en Control documental.`);
    rec.documentoId = a.documento_id || "";
  }
  if (!rec.nombre || !rec.fechaProgramada) fallar("Complete nombre y fecha programada.");
  if (a.dirigida_a !== undefined) {
    const dir = leerDirigida(a.dirigida_a, trabajadores);
    rec.dirigidaA = dir;
    O.sincronizarParticipantes(rec, dir, trabajadores);
  }
  // El cambio manual de la fecha de realización (input de la lista en la
  // app) no recalcula la realización automática; el guardado del formulario sí.
  if (recalcularRealizada) O.actualizarRealizada(rec);
}
async function asegurarHoja(datos, ctx, tx, actividad) {
  const s = await datos.leerStores(ctx.companyId, ["programaPersonas", "programaCargo", "programaPlantillas"]);
  const hoja = O.hojaMensualACrear(actividad, s.programaPersonas, s.programaCargo, s.programaPlantillas);
  if (hoja) await tx.guardar("programaCargo", hoja, null);
}

module.exports = function herramientasCapacitacion(datos) {
  return [
    herramienta({
      name: "capacitaciones_catalogos", title: "Capacitación: catálogos", permiso,
      description: "Tipos de capacitación válidos, cargos existentes en la nómina (para 'Dirigida a' por cargos) y cursos obligatorios configurados.",
      async run(ctx) {
        const s = await datos.leerStores(ctx.companyId, ["trabajadores", "cursosObligatorios"]);
        return {
          tiposCapacitacion: await tiposValidos(datos, ctx),
          cargos: [...new Set(s.trabajadores.map((t) => String(t.cargo || "").trim()).filter(Boolean))].sort(),
          cursosObligatorios: s.cursosObligatorios.map((c) => ({ id: c.id, nombre: c.nombre, vigenciaAnios: c.vigenciaAnios || 0, aplicaA: c.aplicaA || [], tramoMinimo: c.tramoMinimo || "todas" })),
        };
      },
    }),
    herramienta({
      name: "capacitaciones_listar", title: "Capacitación: listar plan", permiso,
      description: "Capacitaciones del plan con filtros. Estado: realizada, atrasada (fecha programada pasada sin realizar) o pendiente.",
      inputSchema: { properties: Object.assign({
        estado: { type: "string", enum: ["pendiente", "realizada", "atrasada"] }, tipo: { type: "string" }, relator: { type: "string" },
        desde: { type: "string", format: "date" }, hasta: { type: "string", format: "date" }, texto: { type: "string" },
      }, esquemaPaginacion) },
      async run(ctx, a) {
        const caps = await datos.leerTodos(ctx.companyId, "capacitaciones");
        const lista = caps.filter((c) => (!a.estado || O.estadoCapacitacion(c) === a.estado) && (!a.tipo || matrizNorm(c.tipo) === matrizNorm(a.tipo))
          && (!a.relator || matrizNorm(c.relator).includes(matrizNorm(a.relator)))
          && (!a.desde || (c.fechaProgramada || "") >= a.desde) && (!a.hasta || (c.fechaProgramada || "") <= a.hasta)
          && contieneTexto([c.nombre, c.tipo, c.relator], a.texto))
          .sort((x, y) => (x.fechaProgramada || "").localeCompare(y.fechaProgramada || "")).map((c) => resumen(c));
        return paginar(lista, a);
      },
    }),
    herramienta({
      name: "capacitacion_detalle", title: "Capacitación: detalle", permiso,
      description: "Detalle de una capacitación con sus participantes (asistencia y aprobación). Devuelve _version para actualizarla.",
      inputSchema: { required: ["id"], properties: { id: { type: "string" } } },
      async run(ctx, a) {
        const c = await datos.leerUno(ctx.companyId, "capacitaciones", a.id);
        if (!c) fallar(`No existe la capacitación ${a.id}.`);
        return resumen(c, mapaPorId(await datos.leerTodos(ctx.companyId, "trabajadores")));
      },
    }),
    herramienta({
      name: "capacitaciones_por_vencer", title: "Capacitación: vencidas y por vencer", permiso,
      description: "Cursos obligatorios vencidos, próximos a vencer o nunca completados por cada trabajador (según su rol y el tramo de la empresa, como la app), y capacitaciones del plan atrasadas o programadas en los próximos días.",
      inputSchema: { properties: {
        dias: { type: "integer", minimum: 1, maximum: 365, description: "Ventana de 'próximo a vencer' (por defecto 60, igual que la app)." },
        incluir_nunca_completados: { type: "boolean", description: "Por defecto sí." },
        trabajador_id: { type: "string" },
      } },
      async run(ctx, a) {
        const dias = a.dias || 60, hoy = hoyIso();
        const s = await datos.leerStores(ctx.companyId, ["trabajadores", "cursosObligatorios", "trabajadorCursos", "capacitaciones", "empresa"]);
        const n = ((s.empresa[0] || {}).numTrabajadores) || 0;
        const alertas = [];
        for (const t of s.trabajadores) {
          if (a.trabajador_id && t.id !== a.trabajador_id) continue;
          for (const c of s.cursosObligatorios.filter((c) => O.cursoAplica(c, t, n))) {
            const reg = O.ultimoCurso(t.id, c.id, s.trabajadorCursos);
            const estado = O.estadoVencimientoCurso(reg, hoy, dias);
            if (estado === "vigente" || (estado === "nunca" && a.incluir_nunca_completados === false)) continue;
            alertas.push({ trabajador: t.nombre, trabajadorId: t.id, cargo: t.cargo || "", curso: c.nombre, cursoId: c.id, estado: O.CURSO_ESTADO_LABEL[estado], vence: reg ? soloFecha(reg.fechaVencimiento) : null, diasParaVencer: reg && reg.fechaVencimiento ? diasHasta(reg.fechaVencimiento, hoy) : null, _orden: { vencido: 0, proximo: 1, nunca: 2 }[estado] });
          }
        }
        alertas.sort((x, y) => x._orden - y._orden || (x.diasParaVencer ?? 99999) - (y.diasParaVencer ?? 99999));
        alertas.forEach((x) => delete x._orden);
        const plan = a.trabajador_id ? [] : s.capacitaciones.filter((c) => { const e = O.estadoCapacitacion(c, hoy); const d = c.fechaProgramada ? diasHasta(c.fechaProgramada, hoy) : null; return e === "atrasada" || (e === "pendiente" && d !== null && d <= dias); })
          .sort((x, y) => (x.fechaProgramada || "").localeCompare(y.fechaProgramada || "")).map((c) => resumen(c));
        return {
          ventanaDias: dias, tramoEmpresa: n,
          cursosObligatorios: { vencidos: alertas.filter((x) => x.estado === "Vencido").length, proximosAVencer: alertas.filter((x) => x.estado === "Próximo a vencer").length, nuncaCompletados: alertas.filter((x) => x.estado === "Nunca completado").length, detalle: alertas.slice(0, 300), truncado: alertas.length > 300 },
          capacitacionesDelPlan: { atrasadas: plan.filter((c) => c.estado === "atrasada").length, programadasEnLaVentana: plan.filter((c) => c.estado === "pendiente").length, detalle: plan.slice(0, 100) },
        };
      },
    }),

    herramienta({
      name: "capacitacion_crear", title: "Capacitación: agregar al plan", permiso, escritura: true,
      description: "Agrega una capacitación al plan (nombre y fecha programada obligatorios). Con dirigida_a se generan los convocados automáticamente. Si el relator es una «Persona del programa», se crea su hoja mensual si falta, como en la app.",
      inputSchema: { required: ["nombre", "fecha_programada"], properties: campos },
      async run(ctx, a) {
        const trabajadores = await datos.leerTodos(ctx.companyId, "trabajadores");
        const tipos = await tiposValidos(datos, ctx);
        const rec = { id: uid(), nombre: "", tipo: tipos[0] || "", fechaProgramada: "", fechaRealizada: null, horas: 0, relator: "", documentoId: "", participantes: [], dirigidaA: { tipo: "ninguno", cargos: [], personasIds: [] } };
        await aplicarCampos(datos, ctx, rec, Object.assign({ dirigida_a: { tipo: "ninguno" } }, a), trabajadores);
        const { resultado } = await datos.transaccion(ctx, "capacitacion_crear", async (tx) => {
          const g = await tx.guardar("capacitaciones", rec, null);
          await asegurarHoja(datos, ctx, tx, rec);
          return g;
        });
        return { mensaje: "Capacitación agregada al plan." + (rec.dirigidaA.tipo !== "ninguno" ? ` Convocados: ${(rec.participantes || []).length}.` : ""), capacitacion: resumen(resultado) };
      },
    }),
    herramienta({
      name: "capacitacion_actualizar", title: "Capacitación: actualizar", permiso, escritura: true,
      description: "Actualiza una capacitación (solo los campos enviados). Cambiar dirigida_a suma convocados nuevos y quita solo a los no asistentes que ya no corresponden (los que asistieron se conservan). fecha_realizada fija o quita (null) la fecha de realización manual. Requiere version_esperada (de capacitacion_detalle).",
      inputSchema: { required: ["id", "version_esperada"], properties: Object.assign({ id: { type: "string" }, version_esperada: esquemaVersion, fecha_realizada: { type: ["string", "null"], format: "date" } }, campos) },
      async run(ctx, a) {
        const trabajadores = await datos.leerTodos(ctx.companyId, "trabajadores");
        const { resultado } = await datos.transaccion(ctx, "capacitacion_actualizar", async (tx) => {
          const ant = await tx.leerBloqueando("capacitaciones", a.id);
          if (!ant) fallar("La capacitación que estabas editando ya no existe.");
          tx.verificarVersion(ant, a.version_esperada);
          const rec = JSON.parse(JSON.stringify(ant));
          if (a.fecha_realizada !== undefined) { rec.fechaRealizada = a.fecha_realizada; rec.realizadaAuto = false; }
          await aplicarCampos(datos, ctx, rec, a, trabajadores, { recalcularRealizada: a.fecha_realizada === undefined });
          const g = await tx.guardar("capacitaciones", rec, ant);
          await asegurarHoja(datos, ctx, tx, rec);
          return g;
        });
        return { mensaje: "Capacitación actualizada.", capacitacion: resumen(resultado) };
      },
    }),
    herramienta({
      name: "capacitacion_registrar_asistencia", title: "Capacitación: registrar asistencia", permiso, escritura: true,
      description: "Marca asistencia y/o aprobación de trabajadores en una capacitación. Si un trabajador no estaba en la lista, se agrega (como 'Agregar' en la app). Con al menos un asistente y sin fecha de realización, la capacitación queda realizada automáticamente.",
      inputSchema: { required: ["id", "registros"], properties: {
        id: { type: "string" },
        registros: { type: "array", minItems: 1, maxItems: 500, items: { type: "object", additionalProperties: false, required: ["trabajador_id"], properties: { trabajador_id: { type: "string" }, asistio: { type: "boolean" }, aprobado: { type: "boolean" } } } },
      } },
      async run(ctx, a) {
        const trabajadores = mapaPorId(await datos.leerTodos(ctx.companyId, "trabajadores"));
        const { resultado } = await datos.transaccion(ctx, "capacitacion_registrar_asistencia", async (tx) => {
          const ant = await tx.leerBloqueando("capacitaciones", a.id);
          if (!ant) fallar(`No existe la capacitación ${a.id}.`);
          const rec = JSON.parse(JSON.stringify(ant));
          rec.participantes = rec.participantes || [];
          for (const r of a.registros) {
            if (!trabajadores[r.trabajador_id]) fallar(`No existe el trabajador ${r.trabajador_id}.`);
            let p = rec.participantes.find((x) => x.trabajadorId === r.trabajador_id);
            if (!p) { p = { trabajadorId: r.trabajador_id, asistio: true, aprobado: false }; rec.participantes.push(p); }
            if (r.asistio !== undefined) p.asistio = r.asistio;
            if (r.aprobado !== undefined) p.aprobado = r.aprobado;
          }
          O.actualizarRealizada(rec);
          return tx.guardar("capacitaciones", rec, ant);
        });
        return { mensaje: "Asistencia registrada.", capacitacion: resumen(resultado, trabajadores) };
      },
    }),
    herramienta({
      name: "trabajador_curso_registrar", title: "Capacitación: registrar curso obligatorio aprobado", permiso, escritura: true,
      description: "Registra que un trabajador aprobó un curso obligatorio. La fecha de vencimiento se calcula con la vigencia del curso (0 = no vence). El certificado se adjunta desde la app.",
      inputSchema: { required: ["trabajador_id", "curso_id", "fecha_aprobacion"], properties: { trabajador_id: { type: "string" }, curso_id: { type: "string" }, fecha_aprobacion: { type: "string", format: "date" } } },
      async run(ctx, a) {
        const t = await datos.leerUno(ctx.companyId, "trabajadores", a.trabajador_id);
        if (!t) fallar(`No existe el trabajador ${a.trabajador_id}.`);
        const curso = await datos.leerUno(ctx.companyId, "cursosObligatorios", a.curso_id);
        if (!curso) fallar(`No existe el curso obligatorio ${a.curso_id}. Ver capacitaciones_catalogos.`);
        const rec = { id: uid(), trabajadorId: t.id, cursoId: curso.id, fechaAprobacion: a.fecha_aprobacion, fechaVencimiento: O.fechaVencimientoCurso(curso, a.fecha_aprobacion), certificadoNombre: null, certificadoData: null, fechaCreacion: new Date().toISOString() };
        const { resultado } = await datos.transaccion(ctx, "trabajador_curso_registrar", (tx) => tx.guardar("trabajadorCursos", rec, null));
        return { mensaje: `Curso «${curso.nombre}» registrado para ${t.nombre}.`, fechaVencimiento: resultado.fechaVencimiento || "No vence", id: resultado.id };
      },
    }),
  ];
};
