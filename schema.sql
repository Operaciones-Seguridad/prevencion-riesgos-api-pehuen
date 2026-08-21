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

-- Catálogo de Proceso/Actividad/Categoría/Peligro compartido por Rubro:
-- a diferencia de "records", esta tabla NO está aislada por company_id a
-- propósito -- es la única pensada para compartirse entre empresas que
-- declaren el mismo Rubro (campo de texto libre en el store "empresa"),
-- para que el catálogo de sugerencias se arme solo a medida que se usan
-- distintos rubros en la instalación, sin depender de una lista fija en
-- el código ni tener que borrar nada por empresa. rubro_norm es el Rubro
-- normalizado (sin tildes, minúsculas, espacios recortados -- ver
-- normRubro() en server.js) para que variaciones de escritura del mismo
-- rubro compartan el mismo grupo.
CREATE TABLE IF NOT EXISTS catalogos_rubro (
  rubro_norm TEXT NOT NULL,
  tipo TEXT NOT NULL,
  valor TEXT NOT NULL,
  creado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rubro_norm, tipo, valor)
);

-- Siembra única de las 49 actividades de trabajo eléctrico en postes/líneas
-- que antes vivían fijas en el código (CAT_ACTIVIDADES, compartidas por
-- TODAS las empresas sin importar su rubro) -- quedan asociadas al rubro
-- "distribucion electrica" (normalizado) para que solo les aparezcan a las
-- empresas de ese rubro. ON CONFLICT DO NOTHING la hace idempotente.
INSERT INTO catalogos_rubro (rubro_norm, tipo, valor) VALUES
  ('distribucion electrica', 'actividad', 'Acopio  y retiro de material'),
  ('distribucion electrica', 'actividad', 'Administración'),
  ('distribucion electrica', 'actividad', 'Almacenamiento'),
  ('distribucion electrica', 'actividad', 'Apertura LBT'),
  ('distribucion electrica', 'actividad', 'Apertura LMT'),
  ('distribucion electrica', 'actividad', 'Apertura puentes BT'),
  ('distribucion electrica', 'actividad', 'Carga, descarga e izamiento de postes'),
  ('distribucion electrica', 'actividad', 'Cierre LBT'),
  ('distribucion electrica', 'actividad', 'Cierre LMT'),
  ('distribucion electrica', 'actividad', 'Cierre puentes BT'),
  ('distribucion electrica', 'actividad', 'Conexión de segundo plano con LMT primer plano energizada mediante clips desmontables'),
  ('distribucion electrica', 'actividad', 'Detección de ausencia de tensión'),
  ('distribucion electrica', 'actividad', 'Entrega de Materiales'),
  ('distribucion electrica', 'actividad', 'Instalación de cobertores en LBT energizada'),
  ('distribucion electrica', 'actividad', 'Instalación de cruceta metálica en segundo plano con LMT en primer plano energizada'),
  ('distribucion electrica', 'actividad', 'Instalación de tierras'),
  ('distribucion electrica', 'actividad', 'Intercalación de poste en LMT energizada'),
  ('distribucion electrica', 'actividad', 'Intervención estructuras adyacentes a líneas energizadas'),
  ('distribucion electrica', 'actividad', E'Izamiento de poste a pulso\nDesplazamiento poste hacia excavación mediante tecle tirfor'),
  ('distribucion electrica', 'actividad', 'Izamiento de postes en cercanía LBT energizada'),
  ('distribucion electrica', 'actividad', 'Izamiento de postes en cercanía de LMT energizada'),
  ('distribucion electrica', 'actividad', 'Manipulación de herramientas'),
  ('distribucion electrica', 'actividad', 'Montaje de BBRR con LMT energizada'),
  ('distribucion electrica', 'actividad', 'Operación de maquinaria'),
  ('distribucion electrica', 'actividad', 'Personal de aseo'),
  ('distribucion electrica', 'actividad', 'Poste quebrado con remate BT y/o telefónico'),
  ('distribucion electrica', 'actividad', 'Recepción de Materiales'),
  ('distribucion electrica', 'actividad', 'Reemplazar tirante MT/BT'),
  ('distribucion electrica', 'actividad', 'Reemplazo de cruceta de madera o metálica en estructura de anclaje en línea'),
  ('distribucion electrica', 'actividad', 'Reemplazo de cruceta de madera o metálica en estructura de anclaje en ángulo'),
  ('distribucion electrica', 'actividad', 'Reemplazo de cruceta de madera o metálica en estructura de remate'),
  ('distribucion electrica', 'actividad', 'Reemplazo de cruceta de madera o metálica en estructura de semianclaje en línea o en ángulo'),
  ('distribucion electrica', 'actividad', 'Reemplazo de cruceta de madera o metálica en estructura portante'),
  ('distribucion electrica', 'actividad', 'Reemplazo de poste c.a. dañado en su base con estructura de anclaje'),
  ('distribucion electrica', 'actividad', 'Reemplazo de poste c.a. dañado estructura portante'),
  ('distribucion electrica', 'actividad', 'Reemplazo de poste c.a. descabezado con estructura de anclaje'),
  ('distribucion electrica', 'actividad', 'Reemplazo de postes de madera por postes c.a.'),
  ('distribucion electrica', 'actividad', 'Reemplazo de postes en cruces de caminos'),
  ('distribucion electrica', 'actividad', 'Retemplar tirantes de MT y BT'),
  ('distribucion electrica', 'actividad', 'Retiro e instalación de estructuras y sub estación'),
  ('distribucion electrica', 'actividad', 'Tendido de conductor cruzando LBT energizada'),
  ('distribucion electrica', 'actividad', 'Tendido de conductor cruzando inferiormente LMT energizada'),
  ('distribucion electrica', 'actividad', 'Tendido de conductor cruzando superiormente LMT energizada (Frontel, otras compañías, ferrocarriles)'),
  ('distribucion electrica', 'actividad', 'Tendido de línea o reemplazo de conductor'),
  ('distribucion electrica', 'actividad', 'Trabajos desde canastillo'),
  ('distribucion electrica', 'actividad', 'Transito por zona de trabajo'),
  ('distribucion electrica', 'actividad', 'Traslado hacia y desde el lugar de faenas'),
  ('distribucion electrica', 'actividad', 'Trepado de postes'),
  ('distribucion electrica', 'actividad', 'Uso de escala')
ON CONFLICT DO NOTHING;
