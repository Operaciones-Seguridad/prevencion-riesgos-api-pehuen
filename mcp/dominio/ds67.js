"use strict";
// Evaluación de siniestralidad DS 67, copiada de index.html (ds67Periodos,
// calcDs67Periodo, calcDs67Evaluacion). Tres "años de prevención" de julio a
// junio; tasa por período = días perdidos / promedio de trabajadores × 100,
// donde el promedio es el de los meses con registro de dotación (los meses
// sin registro no se promedian; un mes registrado con 0 trabajadores sí).

const ACC_TIPOS_DS67_AT = ["ctp", "stp"]; // trayecto queda fuera

function periodos(anioEvaluacion) {
  const out = [];
  for (let i = 2; i >= 0; i--) {
    const ini = anioEvaluacion - i - 1, fin = anioEvaluacion - i;
    const meses = [];
    for (let m = 7; m <= 12; m++) meses.push(`${ini}-${String(m).padStart(2, "0")}`);
    for (let m = 1; m <= 6; m++) meses.push(`${fin}-${String(m).padStart(2, "0")}`);
    out.push({ desde: `Jul ${ini}`, hasta: `Jun ${fin}`, meses });
  }
  return out;
}
const r2 = (x) => Math.round(x * 100) / 100;
function calcPeriodo(periodo, override, accidentes, horasHombre) {
  const meses = new Set(periodo.meses);
  const accs = accidentes.filter((a) => a.fecha && meses.has(a.fecha.slice(0, 7)));
  const atAuto = accs.filter((a) => ACC_TIPOS_DS67_AT.includes(a.tipo)).reduce((s, a) => s + (+a.diasPerdidos || 0), 0);
  const epAuto = accs.filter((a) => a.tipo === "enfermedad").reduce((s, a) => s + (+a.diasPerdidos || 0), 0);
  const tieneCorreccion = !!(override && (override.diasPerdidosAT != null || override.diasPerdidosEP != null));
  const at = override && override.diasPerdidosAT != null ? +override.diasPerdidosAT : atAuto;
  const ep = override && override.diasPerdidosEP != null ? +override.diasPerdidosEP : epAuto;
  const hh = periodo.meses.map((m) => horasHombre.find((h) => h.periodo === m)).filter(Boolean);
  const mesesFaltantes = periodo.meses.filter((m) => !horasHombre.some((h) => h.periodo === m));
  const prom = hh.length ? hh.reduce((s, h) => s + (+h.promedioTrabajadores || 0), 0) / hh.length : 0;
  const tasa = prom ? r2(((at + ep) / prom) * 100) : null;
  return {
    desde: periodo.desde, hasta: periodo.hasta, diasPerdidosAT: at, diasPerdidosEP: ep, diasPerdidosATAuto: atAuto, diasPerdidosEPAuto: epAuto, tieneCorreccion,
    totalDiasPerdidos: at + ep, nAccidentados: accs.filter((a) => a.tipo === "ctp").length, nEnfermos: accs.filter((a) => a.tipo === "enfermedad").length,
    promedioTrabajadores: r2(prom), mesesConDotacion: hh.length, mesesFaltantes, tasa,
  };
}
function calcEvaluacion(anioEvaluacion, registro, accidentes, horasHombre) {
  registro = registro || {};
  const ov = registro.periodosOverride || [null, null, null];
  const ps = periodos(anioEvaluacion).map((p, i) => calcPeriodo(p, ov[i], accidentes, horasHombre));
  const validas = ps.map((p) => p.tasa).filter((t) => t !== null);
  const tasaPromedioIncTemporal = validas.length ? r2(validas.reduce((a, b) => a + b, 0) / validas.length) : 0;
  const factor = +registro.factorInvalidezMuertes || 0, tasaInv = +registro.tasaInvalidezMuertes || 0;
  return {
    anioEvaluacion, periodos: ps, tasaPromedioIncTemporal, factorInvalidezMuertes: factor, tasaInvalidezMuertes: tasaInv,
    tasaSiniestralidadTotal: r2(factor + tasaInv + tasaPromedioIncTemporal), mesesFaltantes: ps.flatMap((p) => p.mesesFaltantes),
  };
}

module.exports = { periodos, calcPeriodo, calcEvaluacion, ACC_TIPOS_DS67_AT };
