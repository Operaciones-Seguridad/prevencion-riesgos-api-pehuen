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
console.log(`Escrito ${destino}: ${simbolos.length} símbolos, ${salida.CATALOG_BASE.peligro.length} peligros base.`);
