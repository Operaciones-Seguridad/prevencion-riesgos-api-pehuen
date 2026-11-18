"use strict";
// Protocolo MCP (transporte HTTP "Streamable", sin estado y con respuestas
// JSON): initialize, ping, tools/list y tools/call. Implementado a mano para
// mantener la regla del proyecto de no depender de más paquetes que "pg".

const { validarEsquema, omitirAdjuntos, ErrorHerramienta } = require("./util");

const VERSIONES = ["2025-11-25", "2025-06-18", "2025-03-26"];
const INFO_SERVIDOR = { name: "pehuen-prevencion-riesgos", title: "Prevención de Riesgos Pehuén", version: "1.0.0" };
const INSTRUCCIONES = [
  "Conector de la app Sistema de Gestión Prevención de Riesgos (Pehuén).",
  "Todo queda limitado a la empresa y a los módulos que el perfil del usuario puede ver en la app.",
  "Los ids de área, trabajador, línea de matriz, etc. se obtienen con las herramientas de listado (p. ej. listar_areas).",
  "Para actualizar un registro, primero léelo con su herramienta de detalle y envía su _version en version_esperada: así no se pisan cambios hechos por otra persona.",
  "El conector puede crear y actualizar, pero nunca eliminar. Cada escritura queda auditada.",
  "Las fechas van en formato AAAA-MM-DD (hora de Chile).",
  "Cada conexión queda ligada a una sola empresa: confírmala con conexion_actual antes de escribir y menciónala al usuario cuando confirmes un cambio.",
].join(" ");
// Instrucciones con la empresa de esta conexión, para que Claude la tenga
// presente desde el inicio de la conversación.
function instruccionesPara(ctx) {
  return `Conectado a la empresa «${ctx.empresa.nombre}» como ${ctx.usuario.nombre || ctx.usuario.email || "usuario"}` +
    `${ctx.perfil ? ` (perfil ${ctx.perfil.nombre})` : ""}${ctx.puedeEscribir ? "" : ", solo lectura"}. ` + INSTRUCCIONES;
}

function crearProtocolo(herramientas) {
  const porNombre = new Map(herramientas.map((h) => [h.name, h]));

  function visibles(ctx) {
    return herramientas.filter((h) => h.permiso(ctx) && (!h.escritura || ctx.puedeEscribir));
  }
  function definicion(h) {
    return {
      name: h.name,
      title: h.title,
      description: h.description,
      inputSchema: h.inputSchema,
      annotations: {
        title: h.title,
        readOnlyHint: !h.escritura,
        destructiveHint: false, // ninguna herramienta elimina
        idempotentHint: !h.escritura,
        openWorldHint: false,
      },
    };
  }

  async function llamar(ctx, nombre, args) {
    const h = porNombre.get(nombre);
    if (!h) return { rpcError: { code: -32602, message: `Herramienta desconocida: ${nombre}` } };
    if (!h.permiso(ctx)) return resultadoError(`Tu perfil (${ctx.perfil ? ctx.perfil.nombre : "sin perfil"}) no tiene acceso a este módulo en la app.`);
    if (h.escritura && !ctx.puedeEscribir) return resultadoError("Esta conexión se autorizó solo para lectura. Para crear o actualizar, vuelve a conectar Claude y marca el permiso de escritura.");
    const argumentos = args && typeof args === "object" ? args : {};
    const errores = validarEsquema(h.inputSchema, argumentos);
    if (errores.length) return resultadoError("Argumentos no válidos:\n- " + errores.join("\n- "));
    try {
      let salida = await h.run(ctx, argumentos);
      // Toda escritura indica en qué empresa quedó guardada.
      if (h.escritura && salida && typeof salida === "object" && !Array.isArray(salida)) {
        salida = Object.assign({ empresa: ctx.empresa.nombre }, salida);
        if (typeof salida.mensaje === "string") salida.mensaje = `${salida.mensaje} (Empresa: ${ctx.empresa.nombre})`;
      }
      return { result: { content: [{ type: "text", text: JSON.stringify(omitirAdjuntos(salida), null, 1) }] } };
    } catch (err) {
      if (err instanceof ErrorHerramienta) return resultadoError(err.message + (err.detalle ? "\n" + JSON.stringify(err.detalle) : ""));
      console.error(`[mcp] error en ${nombre}:`, err);
      return resultadoError("Error interno del servidor al ejecutar la herramienta. No se guardó ningún cambio.");
    }
  }
  function resultadoError(texto) {
    return { result: { content: [{ type: "text", text: texto }], isError: true } };
  }

  // Procesa un mensaje JSON-RPC. Devuelve [statusHttp, cuerpo|null].
  async function procesar(ctx, msg) {
    if (Array.isArray(msg)) return [400, rpcErr(null, -32600, "No se admiten lotes (batch) de JSON-RPC.")];
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return [400, rpcErr(msg && msg.id, -32600, "Solicitud JSON-RPC no válida.")];
    const esNotificacion = msg.id === undefined || msg.id === null;
    if (esNotificacion) return [202, null]; // notifications/initialized, cancelled, etc.
    const id = msg.id, p = msg.params || {};
    switch (msg.method) {
      case "initialize": {
        const pedida = p.protocolVersion;
        return [200, ok(id, {
          protocolVersion: VERSIONES.includes(pedida) ? pedida : VERSIONES[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: INFO_SERVIDOR,
          instructions: instruccionesPara(ctx),
        })];
      }
      case "ping": return [200, ok(id, {})];
      case "tools/list": return [200, ok(id, { tools: visibles(ctx).map(definicion) })];
      case "tools/call": {
        const r = await llamar(ctx, p.name, p.arguments);
        return [200, r.rpcError ? rpcErr(id, r.rpcError.code, r.rpcError.message) : ok(id, r.result)];
      }
      case "resources/list": return [200, ok(id, { resources: [] })];
      case "prompts/list": return [200, ok(id, { prompts: [] })];
      default: return [200, rpcErr(id, -32601, `Método no soportado: ${msg.method}`)];
    }
  }
  return { procesar, visibles, llamar, VERSIONES };
}

function ok(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcErr(id, code, message) { return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } }; }

module.exports = { crearProtocolo, VERSIONES, rpcErr };
