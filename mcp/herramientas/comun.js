"use strict";
// Piezas compartidas por las herramientas de todos los módulos.

const { matrizNorm, fallar } = require("../util");

const LIMITE_POR_DEFECTO = 50;
const LIMITE_MAXIMO = 200;

const esquemaPaginacion = {
  limite: { type: "integer", minimum: 1, maximum: LIMITE_MAXIMO, description: `Cantidad máxima de resultados (por defecto ${LIMITE_POR_DEFECTO}).` },
  desplazamiento: { type: "integer", minimum: 0, description: "Resultados a saltar, para paginar (por defecto 0)." },
};
function paginar(lista, args) {
  const limite = args.limite || LIMITE_POR_DEFECTO, desde = args.desplazamiento || 0;
  return { total: lista.length, desplazamiento: desde, limite, hayMas: desde + limite < lista.length, resultados: lista.slice(desde, desde + limite) };
}
function contieneTexto(campos, q) {
  if (!q) return true;
  const n = matrizNorm(q);
  return matrizNorm(campos.filter(Boolean).join(" ")).includes(n);
}
function mapaPorId(lista) { const m = {}; for (const x of lista) m[x.id] = x; return m; }

// Acepta area_id o el nombre del área (sin importar tildes/mayúsculas).
async function resolverArea(datos, ctx, { area_id, area }, obligatorio) {
  if (!area_id && !area) { if (obligatorio) fallar("Debes indicar el área (area_id o area). Usa listar_areas para ver las opciones."); return null; }
  const areas = await datos.leerTodos(ctx.companyId, "areas");
  let a = area_id ? areas.find((x) => x.id === area_id) : areas.find((x) => matrizNorm(x.nombre) === matrizNorm(area));
  if (!a) fallar(`No existe el área ${JSON.stringify(area_id || area)} en esta empresa.`, { areas_disponibles: areas.map((x) => ({ id: x.id, nombre: x.nombre })) });
  return a;
}
const esquemaArea = {
  area_id: { type: "string", description: "Id del área (ver listar_areas)." },
  area: { type: "string", description: "Nombre del área, como alternativa a area_id." },
};
const esquemaVersion = { type: "string", description: "El _version que devolvió la herramienta de detalle. Si el registro cambió desde entonces, la actualización se rechaza." };

// Define una herramienta con valores por defecto.
function herramienta(def) {
  return Object.assign({ escritura: false }, def, {
    inputSchema: Object.assign({ type: "object", additionalProperties: false, properties: {} }, def.inputSchema || {}),
  });
}

module.exports = { esquemaPaginacion, paginar, contieneTexto, mapaPorId, resolverArea, esquemaArea, esquemaVersion, herramienta, LIMITE_MAXIMO };
