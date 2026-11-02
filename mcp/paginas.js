"use strict";
// Páginas HTML del flujo de autorización OAuth (inicio de sesión y
// consentimiento). Sin scripts ni recursos externos.

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const ESTILO = `
:root{--bg:#f5f6f4;--card:#fff;--txt:#1d2420;--muted:#5d665f;--borde:#d8ddd8;--acento:#14652e;--error:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141815;--card:#1d231f;--txt:#e7ece8;--muted:#a3ada6;--borde:#333b35;--acento:#4cbb6c;--error:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;justify-content:center;padding:24px 16px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--borde);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 4px}p{margin:8px 0;color:var(--muted)}label{display:block;font-weight:600;margin:14px 0 4px}
input[type=email],input[type=password],select{width:100%;padding:10px;border:1px solid var(--borde);border-radius:8px;background:var(--bg);color:var(--txt);font-size:16px}
.permiso{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:10px 0}.permiso input{margin-top:4px}
.botones{display:flex;gap:8px;margin-top:20px;flex-wrap:wrap}button{flex:1;min-width:140px;padding:11px;border-radius:8px;border:1px solid var(--acento);font-size:16px;cursor:pointer}
.primario{background:var(--acento);color:#fff}.secundario{background:transparent;color:var(--txt);border-color:var(--borde)}
.error{color:var(--error);font-weight:600}.cliente{font-weight:600;color:var(--txt)}ul{padding-left:20px;color:var(--muted)}`;

function pagina(titulo, cuerpo) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title><style>${ESTILO}</style></head><body><main>${cuerpo}</main></body></html>`;
}

function camposOcultos(params) {
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
}

function paginaLogin({ params, clienteNombre, error, email, pideEscritura }) {
  return pagina("Conectar Claude con Pehuén", `
<h1>Conectar con Prevención de Riesgos Pehuén</h1>
<p><span class="cliente">${esc(clienteNombre || "Claude")}</span> quiere acceder a tu cuenta. Ingresa con el mismo correo y clave que usas en la app.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${camposOcultos(params)}
<input type="hidden" name="paso" value="login">
<label for="email">Correo</label><input id="email" name="email" type="email" autocomplete="username" required value="${esc(email || "")}">
<label for="clave">Clave</label><input id="clave" name="clave" type="password" autocomplete="current-password" required>
<label>Permisos que otorgas</label>
<div class="permiso"><input type="checkbox" checked disabled><span>Leer la información de los módulos que tu perfil ya puede ver en la app.</span></div>
${pideEscritura ? `<label class="permiso"><input type="checkbox" name="permitir_escritura" value="si" checked><span>Crear y actualizar registros en tu nombre. Nunca puede eliminar. Cada cambio queda auditado.</span></label>` : ""}
<div class="botones"><button class="primario" type="submit" name="accion" value="permitir">Ingresar y autorizar</button>
<button class="secundario" type="submit" name="accion" value="denegar" formnovalidate>Cancelar</button></div>
</form>`);
}

function paginaElegirEmpresa({ params, empresas, ticket, escritura }) {
  return pagina("Elige la empresa", `
<h1>Elige la empresa</h1>
<p>Tu correo tiene acceso a más de una empresa. Claude quedará conectado solo a la que elijas.</p>
<form method="post" action="/oauth/authorize">
${camposOcultos(params)}
<input type="hidden" name="paso" value="empresa"><input type="hidden" name="ticket" value="${esc(ticket)}">
${escritura ? `<input type="hidden" name="permitir_escritura" value="si">` : ""}
<label for="empresaId">Empresa</label>
<select id="empresaId" name="empresaId">${empresas.map((e) => `<option value="${esc(e.id)}">${esc(e.nombre)}</option>`).join("")}</select>
<div class="botones"><button class="primario" type="submit" name="accion" value="permitir">Autorizar</button>
<button class="secundario" type="submit" name="accion" value="denegar">Cancelar</button></div>
</form>`);
}

function paginaError(mensaje) {
  return pagina("No se pudo conectar", `<h1>No se pudo conectar</h1><p class="error">${esc(mensaje)}</p><p>Vuelve a intentarlo desde Claude. Si el problema sigue, contacta al administrador de tu empresa.</p>`);
}

module.exports = { paginaLogin, paginaElegirEmpresa, paginaError, esc };
