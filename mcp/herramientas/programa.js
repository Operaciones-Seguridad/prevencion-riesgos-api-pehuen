"use strict";
// Herramientas del Programa de seguridad.

const O = require("../dominio/otros");
const { hoyIso, uid, fallar } = require("../util");
const { PERMISOS } = require("../contexto");
const { esquemaPaginacion, paginar, contieneTexto, mapaPorId, resolverArea, esquemaArea, esquemaVersion, herramienta } = require("./comun");

const permiso = PERMISOS.programa;
const TIPOS = Object.keys(O.PG_TIPOS);

function resumen(p, areasPorId) {
  return {
    id: p.id, nombre: p.nombre, tipo: O.PG_TIPOS[p.tipo] || p.tipo || "", area: (areasPorId[p.areaId] || {}).nombre || "—", areaId: p.areaId,
    responsable: p.responsable || "", fechaProgramada: p.fechaProgramada || null, fechaRealizada: p.fechaRealizada || null,
    estado: O.estadoPrograma(p), tieneRespaldo: !!p.documento, _version: p._version,
  };
}
function filtrar(lista, a, area) {
  return lista.filter((p) => (!area || p.areaId === area.id) && (!a.tipo || p.tipo === a.tipo)
    && (!a.responsable || (p.responsable || "").trim().toLowerCase() === a.responsable.trim().toLowerCase())
    && (!a.estado || O.estadoPrograma(p) === a.estado)
    && (!a.desde || (p.fechaProgramada || "") >= a.desde) && (!a.hasta || (p.fechaProgramada || "") <= a.hasta)
    && (!a.mes || (p.fechaProgramada || "").slice(0, 7) === a.mes)
    && contieneTexto([p.nombre, p.responsable], a.texto));
}
const filtros = Object.assign({}, esquemaArea, {
  tipo: { type: "string", enum: TIPOS },
  responsable: { type: "string", description: "Nombre exacto del responsable." },
  estado: { type: "string", enum: ["pendiente", "realizada", "atrasada"] },
  mes: { type: "string", description: "Mes de la fecha programada, AAAA-MM." },
  desde: { type: "string", format: "date" }, hasta: { type: "string", format: "date" },
  texto: { type: "string" },
});

// Exige que el responsable sea una "Persona del programa" (pcExigirPersona()).
function exigirPersona(nombre, personas) {
  const per = O.personaPorNombre(nombre, personas);
  if (!per) {
    fallar(String(nombre || "").trim()
      ? `«${String(nombre).trim()}» no está en «Personas del programa». Elige a alguien de esa lista (programa_personas_listar) o agrégalo primero en la app, en Programa de seguridad → Personas del programa.`
      : "Elige la persona responsable de la actividad (debe estar en «Personas del programa»).",
    { personas_del_programa: personas.map((x) => x.nombre) });
  }
  return per;
}
async function asegurarHoja(datos, ctx, tx, actividad) {
  const s = await datos.leerStores(ctx.companyId, ["programaPersonas", "programaCargo", "programaPlantillas"]);
  const hoja = O.hojaMensualACrear(actividad, s.programaPersonas, s.programaCargo, s.programaPlantillas);
  if (hoja) await tx.guardar("programaCargo", hoja, null);
  return !!hoja;
}

module.exports = function herramientasPrograma(datos) {
  return [
    herramienta({
      name: "programa_listar", title: "Programa de seguridad: listar actividades", permiso,
      description: "Actividades del Programa de seguridad con filtros. Estado: realizada (con fecha de realización), atrasada (fecha programada pasada sin realizar) o pendiente.",
      inputSchema: { properties: Object.assign({}, filtros, esquemaPaginacion) },
      async run(ctx, a) {
        const s = await datos.leerStores(ctx.companyId, ["programa", "areas"]);
        const area = (a.area_id || a.area) ? await resolverArea(datos, ctx, a) : null;
        const am = mapaPorId(s.areas);
        return paginar(filtrar(s.programa, a, area).sort((x, y) => (x.fechaProgramada || "").localeCompare(y.fechaProgramada || "")).map((p) => resumen(p, am)), a);
      },
    }),
    herramienta({
      name: "programa_detalle", title: "Programa de seguridad: detalle", permiso,
      description: "Detalle de una actividad del programa. Devuelve _version para actualizarla.",
      inputSchema: { required: ["id"], properties: { id: { type: "string" } } },
      async run(ctx, a) {
        const p = await datos.leerUno(ctx.companyId, "programa", a.id);
        if (!p) fallar(`No existe la actividad ${a.id} en el programa.`);
        const am = mapaPorId(await datos.leerTodos(ctx.companyId, "areas"));
        return Object.assign(resumen(p, am), { registro: p });
      },
    }),
    herramienta({
      name: "programa_avance", title: "Programa de seguridad: avance", permiso,
      description: "Avance del programa: % de actividades realizadas sobre programadas (mismo cálculo que la app), total y por responsable, con semáforo ≥80% verde, 50–79% amarillo y <50% rojo. Filtra por mes (AAAA-MM), año, área o responsable. Incluye las atrasadas.",
      inputSchema: { properties: Object.assign({}, esquemaArea, {
        mes: { type: "string", description: "AAAA-MM" }, anio: { type: "integer", minimum: 2000, maximum: 2100 },
        responsable: { type: "string" }, hasta_hoy: { type: "boolean", description: "Contar solo actividades con fecha programada hasta hoy." },
      }) },
      async run(ctx, a) {
        const s = await datos.leerStores(ctx.companyId, ["programa", "areas"]);
        const area = (a.area_id || a.area) ? await resolverArea(datos, ctx, a) : null;
        const hoy = hoyIso();
        const lista = filtrar(s.programa, { mes: a.mes, responsable: a.responsable }, area)
          .filter((p) => (!a.anio || (p.fechaProgramada || "").startsWith(String(a.anio))) && (!a.hasta_hoy || (p.fechaProgramada || "") <= hoy));
        const am = mapaPorId(s.areas);
        const av = O.avancePrograma(lista);
        return Object.assign({ filtro: { mes: a.mes || null, anio: a.anio || null, area: area ? area.nombre : "todas", responsable: a.responsable || null, hastaHoy: !!a.hasta_hoy } }, av, {
          atrasadas: lista.filter((p) => O.estadoPrograma(p, hoy) === "atrasada").sort((x, y) => (x.fechaProgramada || "").localeCompare(y.fechaProgramada || "")).slice(0, 50).map((p) => resumen(p, am)),
        });
      },
    }),
    herramienta({
      name: "programa_personas_listar", title: "Programa de seguridad: personas del programa", permiso,
      description: "Personas del programa (los únicos responsables válidos para actividades con fecha) con su cargo.",
      async run(ctx) {
        return (await datos.leerTodos(ctx.companyId, "programaPersonas")).map((p) => ({ id: p.id, nombre: p.nombre, cargo: p.cargo || "", trabajadorId: p.trabajadorId || null }));
      },
    }),

    herramienta({
      name: "programa_crear_actividad", title: "Programa de seguridad: crear actividad", permiso, escritura: true,
      description: "Agrega una actividad al programa. Nombre, área y fecha programada son obligatorios, y el responsable debe ser una de las «Personas del programa». Si el responsable no tiene hoja mensual para ese mes, se crea (con la planificación de su cargo, si existe), como en la app.",
      inputSchema: { required: ["nombre", "tipo", "fecha_programada", "responsable"], properties: Object.assign({
        nombre: { type: "string", minLength: 1, maxLength: 500 }, tipo: { type: "string", enum: TIPOS },
        responsable: { type: "string", minLength: 1 }, fecha_programada: { type: "string", format: "date" },
      }, esquemaArea) },
      async run(ctx, a) {
        const area = await resolverArea(datos, ctx, a, true);
        const per = exigirPersona(a.responsable, await datos.leerTodos(ctx.companyId, "programaPersonas"));
        const rec = { id: uid(), nombre: a.nombre.trim(), tipo: a.tipo, areaId: area.id, responsable: per.nombre, fechaProgramada: a.fecha_programada, fechaRealizada: null };
        const { resultado } = await datos.transaccion(ctx, "programa_crear_actividad", async (tx) => {
          const g = await tx.guardar("programa", rec, null);
          return { g, hoja: await asegurarHoja(datos, ctx, tx, rec) };
        });
        return { mensaje: "Actividad agregada al programa." + (resultado.hoja ? ` Se creó la hoja mensual de ${per.nombre}.` : ""), actividad: resumen(resultado.g, { [area.id]: area }) };
      },
    }),
    herramienta({
      name: "programa_actualizar_actividad", title: "Programa de seguridad: actualizar actividad", permiso, escritura: true,
      description: "Actualiza nombre, tipo, área, responsable o fecha programada de una actividad (el responsable debe estar en «Personas del programa»). Requiere version_esperada (de programa_detalle).",
      inputSchema: { required: ["id", "version_esperada"], properties: Object.assign({
        id: { type: "string" }, version_esperada: esquemaVersion,
        nombre: { type: "string", minLength: 1, maxLength: 500 }, tipo: { type: "string", enum: TIPOS },
        responsable: { type: "string", minLength: 1 }, fecha_programada: { type: "string", format: "date" },
      }, esquemaArea) },
      async run(ctx, a) {
        const area = (a.area_id || a.area) ? await resolverArea(datos, ctx, a) : null;
        const personas = await datos.leerTodos(ctx.companyId, "programaPersonas");
        const { resultado } = await datos.transaccion(ctx, "programa_actualizar_actividad", async (tx) => {
          const ant = await tx.leerBloqueando("programa", a.id);
          if (!ant) fallar(`No existe la actividad ${a.id} en el programa.`);
          tx.verificarVersion(ant, a.version_esperada);
          const rec = Object.assign({}, ant);
          if (a.nombre !== undefined) rec.nombre = a.nombre.trim();
          if (a.tipo !== undefined) rec.tipo = a.tipo;
          if (area) rec.areaId = area.id;
          if (a.fecha_programada !== undefined) rec.fechaProgramada = a.fecha_programada;
          // La app valida el responsable al editar, aunque no cambie.
          rec.responsable = exigirPersona(a.responsable !== undefined ? a.responsable : rec.responsable, personas).nombre;
          if (!rec.nombre || !rec.fechaProgramada) fallar("Completa el nombre y la fecha programada.");
          const g = await tx.guardar("programa", rec, ant);
          return { g, hoja: await asegurarHoja(datos, ctx, tx, rec) };
        });
        return { mensaje: "Actividad actualizada." + (resultado.hoja ? " Se creó la hoja mensual del responsable." : ""), _version: resultado.g._version };
      },
    }),
    herramienta({
      name: "programa_registrar_realizacion", title: "Programa de seguridad: registrar realización", permiso, escritura: true,
      description: "Registra la fecha en que se realizó una actividad (o fecha_realizada=null para quitar la fecha y que vuelva a pendiente/atrasada; el respaldo adjunto, si existe, se conserva). Los respaldos (archivos) se adjuntan desde la app.",
      inputSchema: { required: ["id", "fecha_realizada"], properties: { id: { type: "string" }, fecha_realizada: { type: ["string", "null"], format: "date" } } },
      async run(ctx, a) {
        const { resultado } = await datos.transaccion(ctx, "programa_registrar_realizacion", async (tx) => {
          const ant = await tx.leerBloqueando("programa", a.id);
          if (!ant) fallar(`No existe la actividad ${a.id} en el programa.`);
          // A diferencia de "Quitar realización" en la app, el conector NO borra
          // el respaldo adjunto (regla: el conector nunca elimina datos).
          const rec = Object.assign({}, ant, { fechaRealizada: a.fecha_realizada });
          return tx.guardar("programa", rec, ant);
        });
        return { mensaje: a.fecha_realizada ? "Realización registrada." : "Se quitó el registro de realización.", estado: O.estadoPrograma(resultado), _version: resultado._version };
      },
    }),
  ];
};
