"use strict";
// Acceso a datos del conector: lecturas con su versión (updated_at) y
// escrituras dentro de una transacción que SIEMPRE deja su fila en
// auditoria_escrituras. El único borrado (tx.eliminar) guarda el registro
// completo en la auditoría para poder restaurarlo.

const { omitirAdjuntos, fallar } = require("./util");

function crearDatos(pool) {
  async function leerTodos(companyId, store) {
    const { rows } = await pool.query(
      "SELECT data, updated_at FROM records WHERE company_id = $1 AND store = $2 ORDER BY updated_at ASC",
      [companyId, store]
    );
    return rows.map((r) => conVersion(r.data, r.updated_at));
  }
  async function leerUno(companyId, store, id) {
    const { rows } = await pool.query(
      "SELECT data, updated_at FROM records WHERE company_id = $1 AND store = $2 AND id = $3",
      [companyId, store, String(id)]
    );
    return rows[0] ? conVersion(rows[0].data, rows[0].updated_at) : null;
  }
  // Varios stores de una vez (para resúmenes que cruzan módulos).
  async function leerStores(companyId, stores) {
    const out = {};
    await Promise.all(stores.map(async (s) => { out[s] = await leerTodos(companyId, s); }));
    return out;
  }
  async function catalogoRubro(companyId, tipo) {
    const emp = await leerUno(companyId, "empresa", "empresa-1") || (await leerTodos(companyId, "empresa"))[0];
    const rubroNorm = normRubro(emp && emp.rubro);
    const { rows } = await pool.query("SELECT valor FROM catalogos_rubro WHERE rubro_norm = $1 AND tipo = $2 ORDER BY valor", [rubroNorm, tipo]);
    return { rubroNorm, valores: rows.map((r) => r.valor) };
  }

  // Ejecuta fn(tx) en una transacción. tx.guardar() hace el upsert del
  // registro y escribe su auditoría; tx.leerBloqueando() toma el registro
  // con FOR UPDATE para que dos escrituras simultáneas no se pisen.
  async function transaccion(ctx, herramienta, fn) {
    const cliente = await pool.connect();
    const escritos = [];
    try {
      await cliente.query("BEGIN");
      const tx = {
        async leerBloqueando(store, id) {
          const { rows } = await cliente.query(
            "SELECT data, updated_at FROM records WHERE company_id = $1 AND store = $2 AND id = $3 FOR UPDATE",
            [ctx.companyId, store, String(id)]
          );
          return rows[0] ? conVersion(rows[0].data, rows[0].updated_at) : null;
        },
        // version_esperada: la _version que vio Claude al leer el registro.
        // Si alguien lo modificó entretanto (desde la app u otra sesión), se
        // rechaza en vez de sobrescribir el cambio ajeno.
        verificarVersion(registro, versionEsperada) {
          if (versionEsperada && registro._version !== versionEsperada) {
            fallar("El registro fue modificado por otra persona después de que lo leíste. Vuelve a leerlo (herramienta de detalle) y repite el cambio sobre la versión actual.", { version_actual: registro._version, version_esperada: versionEsperada });
          }
        },
        async guardar(store, nuevo, anterior, operacion) {
          const limpio = sinVersion(nuevo);
          if (!limpio.id) throw new Error("registro sin id");
          const { rows } = await cliente.query(
            `INSERT INTO records (company_id, store, id, data, updated_at) VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (company_id, store, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
             RETURNING updated_at`,
            [ctx.companyId, store, String(limpio.id), limpio]
          );
          const ant = anterior ? sinVersion(anterior) : null;
          await cliente.query(
            `INSERT INTO auditoria_escrituras
              (company_id, usuario_id, usuario_nombre, origen, client_id, herramienta, store, registro_id, operacion, valor_anterior, valor_nuevo, campos_cambiados)
             VALUES ($1,$2,$3,'mcp',$4,$5,$6,$7,$8,$9,$10,$11)`,
            [ctx.companyId, ctx.usuario.id, ctx.usuario.nombre || "", ctx.clientId || null, herramienta, store, String(limpio.id),
              operacion || (ant ? "actualizar" : "crear"),
              ant ? JSON.stringify(omitirAdjuntos(ant, "auditoria")) : null,
              JSON.stringify(omitirAdjuntos(limpio, "auditoria")),
              JSON.stringify(camposCambiados(ant, limpio))]
          );
          const guardado = conVersion(limpio, rows[0].updated_at);
          escritos.push({ store, id: limpio.id });
          return guardado;
        },
        // Elimina un registro ya leído con leerBloqueando. El registro completo
        // queda en valor_anterior de la auditoría (de ahí se puede restaurar).
        async eliminar(store, anterior, motivo) {
          const ant = sinVersion(anterior);
          await cliente.query("DELETE FROM records WHERE company_id = $1 AND store = $2 AND id = $3", [ctx.companyId, store, String(ant.id)]);
          await cliente.query(
            `INSERT INTO auditoria_escrituras
              (company_id, usuario_id, usuario_nombre, origen, client_id, herramienta, store, registro_id, operacion, valor_anterior, valor_nuevo, campos_cambiados)
             VALUES ($1,$2,$3,'mcp',$4,$5,$6,$7,'eliminar',$8,$9,'[]'::jsonb)`,
            [ctx.companyId, ctx.usuario.id, ctx.usuario.nombre || "", ctx.clientId || null, herramienta, store, String(ant.id),
              JSON.stringify(ant), JSON.stringify({ eliminado: true, motivo: motivo || "" })]
          );
          escritos.push({ store, id: ant.id });
        },
        async agregarCatalogoRubro(rubroNorm, tipo, valor) {
          await cliente.query("INSERT INTO catalogos_rubro (rubro_norm, tipo, valor) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [rubroNorm, tipo, valor]);
        },
      };
      const resultado = await fn(tx);
      await cliente.query("COMMIT");
      return { resultado, escritos };
    } catch (err) {
      try { await cliente.query("ROLLBACK"); } catch (e) { /* conexión ya rota */ }
      throw err;
    } finally {
      cliente.release();
    }
  }

  // Última eliminación hecha por el conector de un registro (para restaurarlo).
  async function ultimaEliminacion(companyId, store, id) {
    const { rows } = await pool.query(
      `SELECT momento, usuario_nombre, valor_anterior, valor_nuevo FROM auditoria_escrituras
       WHERE company_id = $1 AND store = $2 AND registro_id = $3 AND operacion = 'eliminar' ORDER BY id DESC LIMIT 1`,
      [companyId, store, String(id)]);
    return rows[0] || null;
  }

  return { leerTodos, leerUno, leerStores, catalogoRubro, transaccion, ultimaEliminacion };
}

function conVersion(data, updatedAt) {
  return Object.assign({}, data, { _version: new Date(updatedAt).toISOString() });
}
function sinVersion(obj) {
  const c = Object.assign({}, obj);
  delete c._version;
  return c;
}
function camposCambiados(anterior, nuevo) {
  if (!anterior) return Object.keys(nuevo);
  const claves = new Set([...Object.keys(anterior), ...Object.keys(nuevo)]);
  return [...claves].filter((k) => JSON.stringify(anterior[k]) !== JSON.stringify(nuevo[k]));
}
// Misma normalización que normRubro() en server.js.
function normRubro(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}

module.exports = { crearDatos, sinVersion, camposCambiados, normRubro };
