"use strict";
// Contexto de cada llamada al conector: usuario, empresa y perfil se
// vuelven a leer en CADA solicitud (no se confía en lo que había al
// emitir el token), así que desactivar a alguien o cambiar su perfil en
// la app rige de inmediato.

const { puedeAceptarRiesgos } = require("./dominio/miper");

// Mismo listado de vistas que sembrarEmpresaNueva() en server.js.
const TODAS_LAS_VISTAS = ["dashboard", "diagnostico", "objetivos", "realizar-inspecciones", "inspecciones", "matriz", "vigilancia", "programa", "capacitacion", "accidentabilidad", "seguridad", "epp", "cumplimiento", "riohys", "documentos", "cphys", "emergencia", "compromisos", "config"];

// Empresas que pueden usar el conector (variable MCP_EMPRESAS_PERMITIDAS):
// lista separada por comas de ids de empresa o nombres exactos (sin
// importar mayúsculas ni tildes), o "*" para todas. CERRADO POR DEFECTO:
// si la variable no existe o está vacía, ninguna empresa puede conectarse,
// para que publicar el conector nunca lo abra a todos los clientes por error.
function normEmpresa(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, " "); }
function empresaHabilitada(empresa) {
  if (!empresa) return false;
  const lista = String(process.env.MCP_EMPRESAS_PERMITIDAS || "").split(",").map(normEmpresa).filter(Boolean);
  if (lista.includes("*")) return true;
  return lista.includes(normEmpresa(empresa.id)) || lista.includes(normEmpresa(empresa.nombre));
}

async function construirContexto(pool, dbGetEmpresa, tokenRow) {
  const companyId = tokenRow.company_id;
  const empresa = await dbGetEmpresa(companyId);
  if (!empresa || empresa.activo === false || empresa.aprobada === false || !empresaHabilitada(empresa)) return null;
  const leer = async (store, id) => {
    const { rows } = await pool.query("SELECT data FROM records WHERE company_id = $1 AND store = $2 AND id = $3", [companyId, store, String(id || "")]);
    return rows[0] ? rows[0].data : null;
  };
  const usuario = await leer("accesoUsuarios", tokenRow.usuario_id);
  if (!usuario || usuario.activo === false) return null;
  const perfil = usuario.perfilId ? await leer("accesoPerfiles", usuario.perfilId) : null;
  const esAdmin = !!(perfil && perfil.esAdmin);
  // Sin perfil asignado no se otorga ninguna vista (más estricto que la
  // app, que sin sistema de sesión muestra todo).
  const vistas = new Set(esAdmin ? TODAS_LAS_VISTAS : (perfil && Array.isArray(perfil.vistas) ? perfil.vistas : []));
  const alcances = new Set(String(tokenRow.scope || "").split(/\s+/).filter(Boolean));
  return {
    companyId,
    empresa: { id: empresa.id, nombre: empresa.nombre },
    usuario: { id: usuario.id, nombre: usuario.nombre || "", email: usuario.email || "", cargo: usuario.cargo || "" },
    perfil: perfil ? { id: perfil.id, nombre: perfil.nombre || "", esAdmin } : null,
    esAdmin,
    vistas,
    ve: (v) => esAdmin || vistas.has(v),
    puedeAceptarRiesgos: esAdmin || puedeAceptarRiesgos(perfil),
    puedeEscribir: alcances.has("escritura"),
    alcances,
    clientId: tokenRow.client_id,
  };
}

// Permiso por módulo (acordado con Carlos):
//  - MIPER y Plan de acción → vista "matriz"; Programa → "programa";
//    Capacitación → "capacitacion"; Documentos → "documentos".
//  - Trabajadores: leer con cualquiera de esos módulos o "config";
//    crear/actualizar solo con "config" (donde se administran en la app).
//  - esAdmin ve todo.
const PERMISOS = {
  matriz: (c) => c.ve("matriz"),
  programa: (c) => c.ve("programa"),
  capacitacion: (c) => c.ve("capacitacion"),
  documentos: (c) => c.ve("documentos"),
  trabajadores_lectura: (c) => ["matriz", "programa", "capacitacion", "documentos", "config"].some((v) => c.ve(v)),
  trabajadores_escritura: (c) => c.ve("config"),
  general: (c) => ["matriz", "programa", "capacitacion", "documentos", "config"].some((v) => c.ve(v)),
  admin: (c) => c.esAdmin,
};

module.exports = { construirContexto, PERMISOS, TODAS_LAS_VISTAS, empresaHabilitada };
