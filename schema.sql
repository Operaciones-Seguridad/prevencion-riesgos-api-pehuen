-- Esquema multi-empresa para el backend de Pehuén.
--
-- IMPORTANTE: este archivo está escrito para poder correr de forma segura
-- tanto en una base de datos NUEVA (instalación desde cero) como en la
-- base de datos REAL de Pehuén que ya tiene datos guardados con el
-- esquema anterior (una sola empresa, tabla "records" con PRIMARY KEY
-- (store, id), sin tabla "empresas"). Cada paso es idempotente (usa
-- IF NOT EXISTS / ON CONFLICT / chequeos previos), así que corre sin
-- problema en cada arranque del servidor, se ejecute una vez o cien veces.
--
-- Qué hace, en orden:
--   1. Crea la tabla "empresas" (registro maestro de compañías) si no existe.
--   2. Crea la fila de la empresa "Pehuén" (id fijo 'pehuen') si no existe
--      todavía -- así TODOS los datos que ya estaban guardados antes de
--      esta migración (áreas, trabajadores, matriz, documentos, usuarios,
--      claves, etc.) quedan asociados a esta empresa sin perderse ni
--      tocarse: solo se les agrega la etiqueta de a qué empresa pertenecen.
--   3. Crea la tabla "records" si no existe (instalación nueva) -- si ya
--      existe (caso real de Pehuén), este paso no hace nada.
--   4. Agrega la columna company_id a "records" si todavía no la tiene.
--   5. Rellena (backfill) company_id = 'pehuen' en todas las filas que ya
--      existían antes de esta migración (company_id todavía nulo).
--   6. Deja company_id como obligatorio.
--   7. Reemplaza la llave primaria (store, id) por (company_id, store, id).
--   8. Agrega la llave foránea hacia "empresas" (borra en cascada).
--   9. Crea el índice por (company_id, store).
CREATE TABLE IF NOT EXISTS empresas (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  creado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO empresas (id, nombre) VALUES ('pehuen', 'Pehuén')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS records (
  store TEXT NOT NULL,
  id TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE records ADD COLUMN IF NOT EXISTS company_id TEXT;

UPDATE records SET company_id = 'pehuen' WHERE company_id IS NULL;

ALTER TABLE records ALTER COLUMN company_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage
    WHERE table_name = 'records' AND column_name = 'company_id'
      AND constraint_name IN (
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_name = 'records' AND constraint_type = 'PRIMARY KEY'
      )
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'records' AND constraint_type = 'PRIMARY KEY'
    ) THEN
      EXECUTE (
        SELECT 'ALTER TABLE records DROP CONSTRAINT ' || constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'records' AND constraint_type = 'PRIMARY KEY'
        LIMIT 1
      );
    END IF;
    ALTER TABLE records ADD PRIMARY KEY (company_id, store, id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'records' AND constraint_type = 'FOREIGN KEY' AND constraint_name = 'records_company_id_fkey'
  ) THEN
    ALTER TABLE records ADD CONSTRAINT records_company_id_fkey FOREIGN KEY (company_id) REFERENCES empresas(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_records_company_store ON records(company_id, store);
DROP INDEX IF EXISTS idx_records_store;
