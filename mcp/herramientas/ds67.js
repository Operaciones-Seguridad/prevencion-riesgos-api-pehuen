"use strict";
// Dotación mensual (horas-hombre) y evaluación de siniestralidad DS 67.

const D = require("../dominio/ds67");
const { uid, fallar } = require("../util");
const { PERMISOS } = require("../contexto");
const { herramienta } = require("./comun");

const permiso = PERMISOS.accidentabilidad;
const PERIODO = { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$", description: "Mes AAAA-MM" };

function fila(h) {
  return { periodo: h.periodo, promedioTrabajadores: +h.promedioTrabajadores || 0, horasHombre: +h.horasHombre || 0, sinHorasHombre: !(+h.horasHombre > 0), _version: h._version };
}

module.exports = function herramientasDs67(datos) {
  return [
    herramienta({
      name: "dotacion_listar", title: "Accidentabilidad: dotación y horas-hombre por mes", permiso,
      description: "Registros mensuales de dotación (promedio de trabajadores) y horas-hombre, ordenados por mes. Marca los meses que aún no tienen horas-hombre.",
      inputSchema: { properties: { desde: PERIODO, hasta: PERIODO } },
      async run(ctx, a) {
        const hh = (await datos.leerTodos(ctx.companyId, "horasHombre")).filter((h) => (!a.desde || h.periodo >= a.desde) && (!a.hasta || h.periodo <= a.hasta))
          .sort((x, y) => String(x.periodo).localeCompare(String(y.periodo)));
        return { meses: hh.map(fila), totalMeses: hh.length, mesesSinHorasHombre: hh.filter((h) => !(+h.horasHombre > 0)).map((h) => h.periodo) };
      },
    }),
    herramienta({
      name: "dotacion_cargar", title: "Accidentabilidad: cargar dotación mensual", permiso, escritura: true,
      description: "Carga en bloque la dotación (promedio de trabajadores) de muchos meses, por ejemplo desde el simulador DS 67 de la mutualidad. Las horas-hombre son opcionales: si no se envían, un mes nuevo queda con 0 y un mes existente conserva las suyas, para completarlas después en la app (Horas-hombre, mismo mes) o con esta herramienta. Se aceptan meses con 0 trabajadores, que cuentan en el promedio igual que en la mutualidad. Si un mes ya tiene otra dotación registrada, exige sobrescribir=true.",
      inputSchema: { required: ["meses"], properties: {
        meses: { type: "array", minItems: 1, maxItems: 120, items: { type: "object", additionalProperties: false, required: ["periodo", "promedio_trabajadores"], properties: {
          periodo: PERIODO, promedio_trabajadores: { type: "number", minimum: 0, maximum: 1000000 }, horas_hombre: { type: "number", minimum: 0 },
        } } },
        sobrescribir: { type: "boolean", description: "Permite cambiar la dotación de meses que ya tienen otro valor." },
      } },
      async run(ctx, a) {
        const vistos = new Set();
        for (const m of a.meses) { if (vistos.has(m.periodo)) fallar(`El mes ${m.periodo} viene repetido.`); vistos.add(m.periodo); }
        const existentes = await datos.leerTodos(ctx.companyId, "horasHombre");
        const conflictos = a.meses.map((m) => ({ m, e: existentes.find((h) => h.periodo === m.periodo) }))
          .filter(({ m, e }) => e && (+e.promedioTrabajadores || 0) !== m.promedio_trabajadores);
        if (conflictos.length && !a.sobrescribir) {
          fallar(`${conflictos.length} mes(es) ya tienen otra dotación registrada. Revisa y vuelve a enviar con sobrescribir=true si corresponde.`,
            { meses: conflictos.map(({ m, e }) => ({ periodo: m.periodo, actual: +e.promedioTrabajadores || 0, nuevo: m.promedio_trabajadores })) });
        }
        const res = await datos.transaccion(ctx, "dotacion_cargar", async (tx) => {
          const out = { creados: [], actualizados: [], sinCambios: [] };
          for (const m of a.meses.slice().sort((x, y) => x.periodo.localeCompare(y.periodo))) {
            const e = existentes.find((h) => h.periodo === m.periodo);
            const ant = e ? await tx.leerBloqueando("horasHombre", e.id) : null;
            const rec = ant ? Object.assign({}, ant) : { id: uid(), periodo: m.periodo, horasHombre: 0, promedioTrabajadores: 0 };
            delete rec._version;
            rec.promedioTrabajadores = m.promedio_trabajadores;
            if (m.horas_hombre !== undefined) rec.horasHombre = m.horas_hombre;
            if (ant && +ant.promedioTrabajadores === rec.promedioTrabajadores && +ant.horasHombre === +rec.horasHombre) { out.sinCambios.push(m.periodo); continue; }
            await tx.guardar("horasHombre", rec, ant);
            (ant ? out.actualizados : out.creados).push(m.periodo);
          }
          return out;
        });
        const r = res.resultado;
        return {
          mensaje: `Dotación cargada: ${r.creados.length} mes(es) nuevo(s), ${r.actualizados.length} actualizado(s), ${r.sinCambios.length} sin cambios.`,
          creados: r.creados, actualizados: r.actualizados, sinCambios: r.sinCambios,
          aviso: a.meses.some((m) => m.horas_hombre === undefined) ? "Los meses sin horas-hombre quedan en 0: complétalas para que las tasas de frecuencia y gravedad sean correctas (el DS 67 no las usa)." : undefined,
        };
      },
    }),
    herramienta({
      name: "ds67_evaluacion", title: "Accidentabilidad: evaluación DS 67", permiso,
      description: "Calcula la evaluación de siniestralidad DS 67 de un año, igual que la app: 3 períodos de julio a junio, días perdidos (del registro de accidentes o la corrección guardada), promedio de trabajadores de los meses con dotación, tasas por período y total, y los meses que faltan. Úsala para comparar con el simulador de la mutualidad.",
      inputSchema: { required: ["anio_evaluacion"], properties: { anio_evaluacion: { type: "integer", minimum: 2000, maximum: 2100 } } },
      async run(ctx, a) {
        const s = await datos.leerStores(ctx.companyId, ["ds67Evaluaciones", "accidentes", "horasHombre"]);
        const reg = s.ds67Evaluaciones.find((r) => +r.anioEvaluacion === a.anio_evaluacion);
        return Object.assign(D.calcEvaluacion(a.anio_evaluacion, reg, s.accidentes, s.horasHombre), { registroGuardado: !!reg, _version: reg ? reg._version : null });
      },
    }),
    herramienta({
      name: "ds67_evaluacion_guardar", title: "Accidentabilidad: guardar datos de la evaluación DS 67", permiso, escritura: true,
      description: "Guarda los datos que informa la mutualidad para un año de evaluación: factor y tasa de invalideces y muertes, y la corrección de días perdidos por período (1 = el más antiguo, 3 = el más reciente; los períodos no enviados conservan lo que tenían). Devuelve la evaluación recalculada.",
      inputSchema: { required: ["anio_evaluacion"], properties: {
        anio_evaluacion: { type: "integer", minimum: 2000, maximum: 2100 },
        factor_invalidez_muertes: { type: "number", minimum: 0 }, tasa_invalidez_muertes: { type: "number", minimum: 0 },
        dias_perdidos: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["periodo"], properties: {
          periodo: { type: "integer", minimum: 1, maximum: 3 }, accidentes_trabajo: { type: "number", minimum: 0 }, enfermedad_profesional: { type: "number", minimum: 0 },
        } } },
      } },
      async run(ctx, a) {
        const existentes = await datos.leerTodos(ctx.companyId, "ds67Evaluaciones");
        const e = existentes.find((r) => +r.anioEvaluacion === a.anio_evaluacion);
        const { resultado } = await datos.transaccion(ctx, "ds67_evaluacion_guardar", async (tx) => {
          const ant = e ? await tx.leerBloqueando("ds67Evaluaciones", e.id) : null;
          const rec = ant ? Object.assign({}, ant) : { id: uid(), anioEvaluacion: a.anio_evaluacion, factorInvalidezMuertes: 0, tasaInvalidezMuertes: 0, periodosOverride: [null, null, null] };
          delete rec._version;
          if (a.factor_invalidez_muertes !== undefined) rec.factorInvalidezMuertes = a.factor_invalidez_muertes;
          if (a.tasa_invalidez_muertes !== undefined) rec.tasaInvalidezMuertes = a.tasa_invalidez_muertes;
          const ov = (rec.periodosOverride || [null, null, null]).slice(0, 3);
          while (ov.length < 3) ov.push(null);
          for (const d of a.dias_perdidos || []) {
            const prev = ov[d.periodo - 1] || {};
            // Igual que la app al guardar: un período corregido lleva ambos valores (vacío = 0).
            ov[d.periodo - 1] = { diasPerdidosAT: d.accidentes_trabajo !== undefined ? d.accidentes_trabajo : (prev.diasPerdidosAT ?? 0), diasPerdidosEP: d.enfermedad_profesional !== undefined ? d.enfermedad_profesional : (prev.diasPerdidosEP ?? 0) };
          }
          rec.periodosOverride = ov;
          return tx.guardar("ds67Evaluaciones", rec, ant);
        });
        const s = await datos.leerStores(ctx.companyId, ["accidentes", "horasHombre"]);
        return { mensaje: "Datos guardados.", evaluacion: D.calcEvaluacion(a.anio_evaluacion, resultado, s.accidentes, s.horasHombre) };
      },
    }),
  ];
};
