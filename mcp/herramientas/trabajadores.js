"use strict";
// Herramientas de Trabajadores (nómina) y Áreas.

const O = require("../dominio/otros");
const { hoyIso, uid, fallar, matrizNorm, soloFecha } = require("../util");
const { PERMISOS } = require("../contexto");
const { esquemaPaginacion, paginar, contieneTexto, mapaPorId, resolverArea, esquemaArea, esquemaVersion, herramienta } = require("./comun");

const ROLES = Object.keys(O.ROLES_TRABAJADOR);
function resumen(t, am) {
  return { id: t.id, nombre: t.nombre, rut: t.rut || "", cargo: t.cargo || "", area: (am[t.areaId] || {}).nombre || "—", areaId: t.areaId || null, roles: (t.roles || []).map((r) => O.ROLES_TRABAJADOR[r] || r), _version: t._version };
}

module.exports = function herramientasTrabajadores(datos) {
  return [
    herramienta({
      name: "listar_areas", title: "Áreas de la empresa", permiso: PERMISOS.general,
      description: "Áreas de la empresa con su id (necesario para filtrar y para crear registros en casi todos los módulos).",
      async run(ctx) { return (await datos.leerTodos(ctx.companyId, "areas")).map((a) => ({ id: a.id, nombre: a.nombre })); },
    }),
    herramienta({
      name: "trabajadores_listar", title: "Trabajadores: listar", permiso: PERMISOS.trabajadores_lectura,
      description: "Nómina de trabajadores con filtros por área, cargo, rol o texto (nombre o RUT).",
      inputSchema: { properties: Object.assign({}, esquemaArea, { cargo: { type: "string" }, rol: { type: "string", enum: ROLES }, texto: { type: "string" } }, esquemaPaginacion) },
      async run(ctx, a) {
        const s = await datos.leerStores(ctx.companyId, ["trabajadores", "areas"]);
        const area = (a.area_id || a.area) ? await resolverArea(datos, ctx, a) : null;
        const am = mapaPorId(s.areas);
        const lista = s.trabajadores.filter((t) => (!area || t.areaId === area.id) && (!a.cargo || matrizNorm(t.cargo) === matrizNorm(a.cargo))
          && (!a.rol || (t.roles || []).includes(a.rol)) && contieneTexto([t.nombre, t.rut, t.cargo], a.texto))
          .sort((x, y) => (x.nombre || "").localeCompare(y.nombre || "")).map((t) => resumen(t, am));
        return paginar(lista, a);
      },
    }),
    herramienta({
      name: "trabajador_detalle", title: "Trabajadores: detalle", permiso: PERMISOS.trabajadores_lectura,
      description: "Datos de un trabajador; si el perfil ve Capacitación, también sus cursos obligatorios (estado de vigencia) y las capacitaciones en que participa; si ve Inducción y cumplimiento, sus documentos personales (versión actual y vencimiento). Devuelve _version.",
      inputSchema: { required: ["id"], properties: { id: { type: "string" } } },
      async run(ctx, a) {
        const t = await datos.leerUno(ctx.companyId, "trabajadores", a.id);
        if (!t) fallar(`No existe el trabajador ${a.id}.`);
        const am = mapaPorId(await datos.leerTodos(ctx.companyId, "areas"));
        const out = resumen(t, am);
        if (ctx.ve("capacitacion")) {
          const s = await datos.leerStores(ctx.companyId, ["cursosObligatorios", "trabajadorCursos", "capacitaciones", "empresa"]);
          const n = ((s.empresa[0] || {}).numTrabajadores) || 0, hoy = hoyIso();
          out.cursosObligatorios = s.cursosObligatorios.filter((c) => O.cursoAplica(c, t, n)).map((c) => {
            const reg = O.ultimoCurso(t.id, c.id, s.trabajadorCursos);
            return { curso: c.nombre, cursoId: c.id, estado: O.CURSO_ESTADO_LABEL[O.estadoVencimientoCurso(reg, hoy)], aprobado: reg ? soloFecha(reg.fechaAprobacion) : null, vence: reg ? soloFecha(reg.fechaVencimiento) : null };
          });
          out.capacitaciones = s.capacitaciones.filter((c) => (c.participantes || []).some((p) => p.trabajadorId === t.id)).map((c) => {
            const p = c.participantes.find((x) => x.trabajadorId === t.id);
            return { id: c.id, nombre: c.nombre, fechaProgramada: c.fechaProgramada, estado: O.estadoCapacitacion(c, hoy), asistio: !!p.asistio, aprobado: !!p.aprobado };
          });
        }
        if (ctx.ve("riohys")) {
          const hoy = hoyIso();
          out.documentos = O.docsTrabajadorActuales(await datos.leerTodos(ctx.companyId, "trabajadorDocumentos"), t.id)
            .sort((x, y) => (x.nombre || "").localeCompare(y.nombre || ""))
            .map((r) => ({ id: r.id, nombre: r.nombre, entidad: r.entidad || "", fechaControl: soloFecha(r.fechaControl), vence: soloFecha(r.fechaVencimiento), estado: O.DOC_TRAB_ESTADO_LABEL[O.estadoDocTrabajador(r, hoy)], archivo: r.archivoNombre || null }));
        }
        return out;
      },
    }),
    herramienta({
      name: "trabajador_crear", title: "Trabajadores: agregar", permiso: PERMISOS.trabajadores_escritura, escritura: true,
      description: "Agrega un trabajador a la nómina (nombre y área obligatorios, como en Configuración de la app). Avisa si ya existe otro con el mismo RUT, sin bloquear.",
      inputSchema: { required: ["nombre"], properties: Object.assign({ nombre: { type: "string", minLength: 1, maxLength: 200 }, rut: { type: "string", maxLength: 20 }, cargo: { type: "string", maxLength: 200 }, roles: { type: "array", items: { type: "string", enum: ROLES } } }, esquemaArea) },
      async run(ctx, a) {
        const area = await resolverArea(datos, ctx, a, true);
        const rec = { id: uid(), nombre: a.nombre.trim(), rut: (a.rut || "").trim(), cargo: (a.cargo || "").trim(), areaId: area.id, roles: [...new Set(a.roles || [])] };
        const otros = await datos.leerTodos(ctx.companyId, "trabajadores");
        const dup = rec.rut ? otros.filter((t) => t.rut && t.rut.replace(/[.\s-]/g, "").toLowerCase() === rec.rut.replace(/[.\s-]/g, "").toLowerCase()) : [];
        const { resultado } = await datos.transaccion(ctx, "trabajador_crear", (tx) => tx.guardar("trabajadores", rec, null));
        return { mensaje: "Trabajador agregado.", trabajador: resumen(resultado, { [area.id]: area }), ...(dup.length ? { aviso: `Ya existe otro trabajador con el RUT ${rec.rut}: ${dup.map((t) => t.nombre).join(", ")}.` } : {}) };
      },
    }),
    herramienta({
      name: "trabajador_actualizar", title: "Trabajadores: actualizar", permiso: PERMISOS.trabajadores_escritura, escritura: true,
      description: "Actualiza nombre, RUT, cargo, área o roles de un trabajador (solo los campos enviados; roles reemplaza la lista). Requiere version_esperada (de trabajador_detalle).",
      inputSchema: { required: ["id", "version_esperada"], properties: Object.assign({ id: { type: "string" }, version_esperada: esquemaVersion, nombre: { type: "string", minLength: 1, maxLength: 200 }, rut: { type: "string", maxLength: 20 }, cargo: { type: "string", maxLength: 200 }, roles: { type: "array", items: { type: "string", enum: ROLES } } }, esquemaArea) },
      async run(ctx, a) {
        const area = (a.area_id || a.area) ? await resolverArea(datos, ctx, a) : null;
        const { resultado } = await datos.transaccion(ctx, "trabajador_actualizar", async (tx) => {
          const ant = await tx.leerBloqueando("trabajadores", a.id);
          if (!ant) fallar(`No existe el trabajador ${a.id}.`);
          tx.verificarVersion(ant, a.version_esperada);
          const rec = Object.assign({}, ant);
          for (const k of ["nombre", "rut", "cargo"]) if (a[k] !== undefined) rec[k] = a[k].trim();
          if (area) rec.areaId = area.id;
          if (a.roles !== undefined) rec.roles = [...new Set(a.roles)];
          if (!rec.nombre || !rec.areaId) fallar("Complete nombre y área.");
          return tx.guardar("trabajadores", rec, ant);
        });
        return { mensaje: "Trabajador actualizado.", _version: resultado._version };
      },
    }),
  ];
};
