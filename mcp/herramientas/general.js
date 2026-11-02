"use strict";
// Herramientas transversales: búsqueda en los módulos permitidos y
// consulta de la auditoría del conector (solo administradores).

const M = require("../dominio/miper");
const { contieneTexto, mapaPorId, herramienta } = require("./comun");
const { PERMISOS } = require("../contexto");

module.exports = function herramientasGenerales(datos, pool) {
  return [
    herramienta({
      name: "buscar", title: "Buscar en todos los módulos", permiso: PERMISOS.general,
      description: "Busca un texto en MIPER, Plan de acción, Programa de seguridad, Capacitación, Control documental y Trabajadores (solo en los módulos que tu perfil puede ver). Devuelve hasta 10 coincidencias por módulo, con su id para pedir el detalle.",
      inputSchema: { required: ["texto"], properties: { texto: { type: "string", minLength: 2 } } },
      async run(ctx, a) {
        const q = a.texto, out = {};
        const top = (l) => ({ total: l.length, resultados: l.slice(0, 10) });
        const areas = mapaPorId(await datos.leerTodos(ctx.companyId, "areas"));
        if (PERMISOS.matriz(ctx)) {
          const s = await datos.leerStores(ctx.companyId, ["matriz", "planAccionMatriz"]);
          out.miper = top(s.matriz.filter((m) => contieneTexto([m.proceso, m.actividad, m.peligro, m.riesgo, m.categoria, m.controles, (areas[m.areaId] || {}).nombre], q))
            .map((m) => ({ id: m.id, linea: M.matrizLineLabel(m), area: (areas[m.areaId] || {}).nombre || "—", nivelEfectivo: M.nivelLabel(M.nivelRiesgoLinea(m)) })));
          out.planAccion = top(s.planAccionMatriz.filter((p) => contieneTexto([p.actividad, p.responsable], q)).map((p) => ({ id: p.id, actividad: p.actividad, responsable: p.responsable, plazo: p.plazo, estado: M.estadoAccionMostrado(p) })));
        }
        if (PERMISOS.programa(ctx)) out.programa = top((await datos.leerTodos(ctx.companyId, "programa")).filter((p) => contieneTexto([p.nombre, p.responsable], q)).map((p) => ({ id: p.id, nombre: p.nombre, responsable: p.responsable, fechaProgramada: p.fechaProgramada })));
        if (PERMISOS.capacitacion(ctx)) out.capacitaciones = top((await datos.leerTodos(ctx.companyId, "capacitaciones")).filter((c) => contieneTexto([c.nombre, c.tipo, c.relator], q)).map((c) => ({ id: c.id, nombre: c.nombre, fechaProgramada: c.fechaProgramada, relator: c.relator })));
        if (PERMISOS.documentos(ctx)) out.documentos = top((await datos.leerTodos(ctx.companyId, "documentos")).filter((d) => contieneTexto([d.nombre, d.descripcion], q)).map((d) => ({ id: d.id, nombre: d.nombre, tipo: d.tipo, version: d.version })));
        if (PERMISOS.trabajadores_lectura(ctx)) out.trabajadores = top((await datos.leerTodos(ctx.companyId, "trabajadores")).filter((t) => contieneTexto([t.nombre, t.rut, t.cargo], q)).map((t) => ({ id: t.id, nombre: t.nombre, cargo: t.cargo, area: (areas[t.areaId] || {}).nombre || "—" })));
        return out;
      },
    }),
    herramienta({
      name: "auditoria_listar", title: "Auditoría de escrituras del conector", permiso: PERMISOS.admin,
      description: "Registro de cada escritura hecha a través del conector en esta empresa: usuario, fecha, herramienta, módulo, registro y campos cambiados. Con incluir_valores=true incluye el valor anterior y nuevo completos. Solo perfiles Administrador.",
      inputSchema: { properties: {
        store: { type: "string", description: "Módulo/store, p. ej. matriz, planAccionMatriz, programa, capacitaciones, documentos, trabajadores." },
        registro_id: { type: "string" }, usuario_id: { type: "string" },
        desde: { type: "string", format: "date" }, hasta: { type: "string", format: "date" },
        incluir_valores: { type: "boolean" }, limite: { type: "integer", minimum: 1, maximum: 200 },
      } },
      async run(ctx, a) {
        const cond = ["company_id = $1"], vals = [ctx.companyId];
        const add = (sql, v) => { vals.push(v); cond.push(sql.replace("?", "$" + vals.length)); };
        if (a.store) add("store = ?", a.store);
        if (a.registro_id) add("registro_id = ?", a.registro_id);
        if (a.usuario_id) add("usuario_id = ?", a.usuario_id);
        if (a.desde) add("momento >= ?::date", a.desde);
        if (a.hasta) add("momento < (?::date + 1)", a.hasta);
        vals.push(a.limite || 50);
        const { rows } = await pool.query(
          `SELECT id, momento, usuario_id, usuario_nombre, client_id, herramienta, store, registro_id, operacion, campos_cambiados${a.incluir_valores ? ", valor_anterior, valor_nuevo" : ""}
           FROM auditoria_escrituras WHERE ${cond.join(" AND ")} ORDER BY momento DESC, id DESC LIMIT $${vals.length}`, vals);
        return rows;
      },
    }),
  ];
};
