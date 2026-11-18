-- ===================== Conector MCP (claude.ai) =====================
-- Lo ejecuta server.js al arrancar, aparte de schema.sql y protegido con
-- try/catch: si algo fallara aquí, la API de la app arranca igual y solo
-- queda desactivado el conector.
-- Tablas propias del conector, a propósito FUERA de "records"/STORES: ni
-- la ruta genérica POST /api/<store> ni ninguna otra llamada de la app
-- puede leerlas ni escribirlas. Todas son nuevas e idempotentes: no
-- modifican ninguna tabla ni dato existente.

-- Clientes OAuth registrados dinámicamente (RFC 7591), p. ej. claude.ai.
CREATE TABLE IF NOT EXISTS oauth_clientes (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,              -- NULL = cliente público (PKCE)
  nombre TEXT NOT NULL DEFAULT '',
  redirect_uris JSONB NOT NULL,
  creado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Códigos de autorización (un solo uso, 10 minutos). Se guarda solo su hash.
CREATE TABLE IF NOT EXISTS oauth_codigos (
  codigo_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clientes(client_id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  usuario_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT,
  expira_at TIMESTAMPTZ NOT NULL,
  usado_at TIMESTAMPTZ,
  familia TEXT NOT NULL
);

-- Tokens de acceso y de renovación del conector (separados de los tokens
-- de sesión de la app). Se guarda solo su hash. "familia" agrupa todos los
-- tokens nacidos de una misma autorización, para revocarlos juntos si se
-- detecta la reutilización de un token de renovación ya rotado.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('acceso', 'renovacion')),
  client_id TEXT NOT NULL REFERENCES oauth_clientes(client_id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  usuario_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT,
  familia TEXT NOT NULL,
  expira_at TIMESTAMPTZ NOT NULL,
  revocado_at TIMESTAMPTZ,
  creado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_familia_idx ON oauth_tokens (familia);
CREATE INDEX IF NOT EXISTS oauth_tokens_usuario_idx ON oauth_tokens (company_id, usuario_id);

-- Auditoría de cada escritura hecha a través del conector: quién, cuándo,
-- desde qué herramienta, qué registro y el valor anterior y nuevo completos
-- (los adjuntos en base64 se reemplazan por su hash y tamaño). Se escribe
-- en la misma transacción que el cambio: si no queda auditado, no se guarda.
CREATE TABLE IF NOT EXISTS auditoria_escrituras (
  id BIGSERIAL PRIMARY KEY,
  momento TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_id TEXT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  usuario_id TEXT NOT NULL,
  usuario_nombre TEXT NOT NULL DEFAULT '',
  origen TEXT NOT NULL DEFAULT 'mcp',
  client_id TEXT,
  herramienta TEXT NOT NULL,
  store TEXT NOT NULL,
  registro_id TEXT NOT NULL,
  operacion TEXT NOT NULL CHECK (operacion IN ('crear', 'actualizar')),
  valor_anterior JSONB,
  valor_nuevo JSONB NOT NULL,
  campos_cambiados JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS auditoria_empresa_momento_idx ON auditoria_escrituras (company_id, momento DESC);
CREATE INDEX IF NOT EXISTS auditoria_registro_idx ON auditoria_escrituras (company_id, store, registro_id);
