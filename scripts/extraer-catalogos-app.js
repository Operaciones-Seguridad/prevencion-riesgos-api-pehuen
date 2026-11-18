#!/usr/bin/env node
"use strict";
// Regenera mcp/dominio/catalogos-app.json a partir del index.html de la app
// (repo prevencion-riesgos-app-pehuen), para que el conector use exactamente
// los mismos símbolos oficiales, jerarquía de controles y catálogos base.
//
//   node scripts/extraer-catalogos-app.js ../prevencion-riesgos-app-pehuen/index.html
//
// Solo lee constantes literales (arreglos/objetos) del archivo: no ejecuta la app.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const archivo = process.argv[2];
if (!archivo) { console.error("Uso: node scripts/extraer-catalogos-app.js <ruta a index.html de la app>"); process.exit(1); }
const src = fs.readFileSync(archivo, "utf8");

function literal(nombre) {
  const i = src.indexOf(`const ${nombre} = `);
  if (i < 0) throw new Error(`No se encontró la constante ${nombre}`);
  let j = src.indexOf("=", i) + 1;
  while (src[j] === " ") j++;
  const abre = src[j], cierra = abre === "[" ? "]" : "}";
  let prof = 0, k = j, enCadena = null;
  for (; k < src.length; k++) {
    const c = src[k];
    if (enCadena) { if (c === "\\") { k++; continue; } if (c === enCadena) enCadena = null; continue; }
    if (c === '"' || c === "'" || c === "`") { enCadena = c; continue; }
    if (c === abre) prof++; else if (c === cierra && --prof === 0) break;
  }
  // Se evalúa en un contexto aislado y vacío: el texto es un literal de datos.
  return vm.runInNewContext("(" + src.slice(j, k + 1) + ")", Object.create(null), { timeout: 1000 });
}

// Lee un arreglo literal escrito en una sola línea como `clave: [ ... ],`.
function listaEnLinea(clave) {
  const m = new RegExp(`\\b${clave}: (\\[[^\\n]*\\]),`).exec(src);
  if (!m) throw new Error(`No se encontró la lista ${clave}`);
  return vm.runInNewContext("(" + m[1] + ")", Object.create(null), { timeout: 1000 });
}

const simbolos = literal("ANEXO1_SIMBOLOS").map(({ icons, ...r }) => r);
const salida = {
  _origen: "Copiado de index.html (app prevencion-riesgos-app-pehuen): ANEXO1_SIMBOLOS (sin iconos), JERARQUIA_DS44 y catálogos base. Si la app cambia estas constantes, regenerar con scripts/extraer-catalogos-app.js.",
  ANEXO1_SIMBOLOS: simbolos,
  JERARQUIA_DS44: literal("JERARQUIA_DS44").map(({ code, label }) => ({ code, label })),
  CATALOG_BASE: {
    proceso: literal("CAT_PROCESOS"), actividad: literal("CAT_ACTIVIDADES"), categoria: literal("CAT_CATEGORIAS"),
    peligro: literal("CAT_PELIGROS"), capTipo: literal("CAT_TIPO_CAPACITACION"),
  },
};
const destino = path.join(__dirname, "..", "mcp", "dominio", "catalogos-app.json");
fs.writeFileSync(destino, JSON.stringify(salida, null, 1));

// Accidentabilidad (fase 2): listas oficiales de la app.
const acc = {
  _origen: "Copiado de index.html (app prevencion-riesgos-app-pehuen), módulo Accidentabilidad. Regenerar con scripts/extraer-catalogos-app.js.",
  ACC_TIPO_LABEL: literal("ACC_TIPO_LABEL"),
  ACC_CRITERIOS_GRAVE: literal("ACC_CRITERIOS_GRAVE"),
  ACC_GRAVEDAD_LABEL: literal("ACC_GRAVEDAD_LABEL"),
  INV_TIPO_EVENTO: literal("INV_TIPO_EVENTO"),
  INV_PARTES_CUERPO: literal("INV_PARTES_CUERPO"),
  INV_TIPO_ACCIDENTE: literal("INV_TIPO_ACCIDENTE"),
  INV_ACCION_SUBESTANDAR: literal("INV_ACCION_SUBESTANDAR"),
  INV_CONDICION_SUBESTANDAR: literal("INV_CONDICION_SUBESTANDAR"),
  INV_FACTORES_PERSONALES: literal("INV_FACTORES_PERSONALES"),
  INV_FACTORES_TRABAJO: literal("INV_FACTORES_TRABAJO"),
  ARBOL_TIPO_LABEL: literal("ARBOL_TIPO_LABEL"),
  ARBOL_PLAZO_LABEL: literal("ARBOL_PLAZO_LABEL"),
  TRANSITO_TIPO_LABEL: literal("TRANSITO_TIPO_LABEL"),
  TRANSITO_TIEMPO_REACCION_SUGERIDO: literal("TRANSITO_TIEMPO_REACCION_SUGERIDO"),
  TRANSITO_CHECKLIST_ITEMS: literal("TRANSITO_CHECKLIST_ITEMS"),
  COEF_FRICCION_REF: literal("COEF_FRICCION_REF"),
  INCIDENTE_TIPOS_BASE: listaEnLinea("tipoIncidente"),
};
const destinoAcc = path.join(__dirname, "..", "mcp", "dominio", "catalogos-accidentabilidad.json");
fs.writeFileSync(destinoAcc, JSON.stringify(acc, null, 1));
console.log(`Escrito ${destinoAcc}: ${acc.TRANSITO_CHECKLIST_ITEMS.length} ítems de tránsito, ${acc.ACC_CRITERIOS_GRAVE.length} criterios de gravedad.`);
console.log(`Escrito ${destino}: ${simbolos.length} símbolos, ${salida.CATALOG_BASE.peligro.length} peligros base.`);
