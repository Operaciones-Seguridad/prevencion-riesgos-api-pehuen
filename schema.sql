-- Esquema minimo: una sola tabla generica que refleja exactamente los
-- "stores" que la app ya usaba en IndexedDB (cada fila = un registro de
-- negocio, identificado por store+id, con el objeto completo en JSONB).
-- Esto permite migrar sin rediseñar el modelo de datos de la app.
CREATE TABLE IF NOT EXISTS records (
  store TEXT NOT NULL,
  id TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store, id)
);

CREATE INDEX IF NOT EXISTS idx_records_store ON records(store);
