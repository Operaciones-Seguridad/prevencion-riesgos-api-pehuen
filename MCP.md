# Conector MCP para claude.ai

Permite usar la app de Prevención de Riesgos Pehuén desde Claude (claude.ai →
Configuración → Conectores → *Agregar conector personalizado*). Claude entra
con el **mismo correo y clave** que la persona usa en la app, y queda limitado a
**su empresa** y a **los módulos que su perfil ve en la app**.

Fase 1: Matriz de riesgos (MIPER, con Plan de acción y riesgo residual),
Programa de seguridad, Capacitación, Control documental y Trabajadores.
Fase 2: Accidentabilidad (accidentes, incidentes, investigación formal,
árbol de causas e investigación de accidentes de tránsito, con fotos).

**URL por empresa:** además de la URL general `/mcp` (que pide elegir la
empresa al conectar), cada empresa tiene su URL directa `/mcp/<alias>`, donde
el alias es su nombre sin tildes, en minúsculas y con guiones (por ejemplo
`/mcp/transportes-pola-ltda`) o su id. Así se puede agregar un conector por
empresa en claude.ai (que no admite dos conectores con la misma URL). Una
conexión hecha por una URL directa solo puede quedar en esa empresa y su token
no sirve en otra URL. Para no revelar qué empresas existen, un alias
desconocido se comporta igual que uno válido hasta verificar la clave.
`conexion_actual` muestra la URL directa de la empresa conectada.

**Empresas habilitadas:** solo las de la variable `MCP_EMPRESAS_PERMITIDAS`
(ids o nombres separados por coma, o `*` para todas). Si no existe, ninguna
empresa puede conectarse: así publicar el conector nunca lo abre a todos los
clientes por error. Quitar una empresa corta de inmediato sus conexiones.

## Cómo funciona

| Pieza | Archivo |
|---|---|
| Rutas `/mcp`, `/oauth/*`, `/.well-known/*` | `mcp/index.js` (enganchado en `server.js`, antes de `/api`) |
| Protocolo MCP (HTTP Streamable sin estado, respuestas JSON) | `mcp/protocolo.js` |
| OAuth 2.1: registro dinámico, PKCE S256, rotación de tokens | `mcp/oauth.js`, `mcp/paginas.js` |
| Permisos por perfil (se releen en cada llamada) | `mcp/contexto.js` |
| Lecturas y escrituras con auditoría en la misma transacción | `mcp/datos.js` |
| Reglas copiadas de la app (`index.html`) | `mcp/dominio/*.js`, `mcp/dominio/catalogos-app.json` |
| Herramientas por módulo | `mcp/herramientas/*.js` |
| Tablas propias (OAuth y auditoría) | `mcp/schema.sql` |

- **No se agregaron dependencias:** solo `pg` y los módulos nativos de Node, igual que el resto del servidor.
- **No cambia nada de la app:**
  - Las rutas `/api` no se tocaron.
  - `schema.sql` y `render.yaml` de producción quedan idénticos.
  - Las tablas del conector se crean aparte, en `mcp/schema.sql`, protegidas con `try/catch`: si algo fallara al crearlas, la API arranca igual, solo que sin conector.
- **Tokens propios:** los tokens del conector son distintos de los de sesión de la app y no sirven para `/api`, ni al revés.

## Herramientas (59)

Ninguna herramienta elimina. Todas declaran `destructiveHint: false`, así que claude.ai pide confirmación antes de cada escritura.

**Generales**
- `conexion_actual`: empresa, usuario, perfil, permisos y módulos de la conexión. Cada conexión queda ligada a una sola empresa; además, cada escritura indica en qué empresa se guardó y las instrucciones iniciales del servidor le dicen a Claude con qué empresa está conectado.
- `listar_areas`
- `buscar`
- `auditoria_listar` (solo Administrador)

**MIPER y Plan de acción** (vista `matriz`)
- Lectura:
  - `miper_catalogos`, `miper_listar`, `miper_detalle`
  - `miper_riesgos_criticos`, `miper_resumen`
  - `plan_accion_listar`
- Escritura:
  - `miper_crear_linea`, `miper_actualizar_linea`, `miper_reasignar_area` (cambia el área de hasta 300 líneas en una operación, todo o nada)
  - `plan_accion_crear`, `plan_accion_actualizar`, `plan_accion_cambiar_estado`, `plan_accion_marcar_cumplida`
  - `miper_aceptar_riesgo_medio`, `miper_revocar_aceptacion`: además exigen el permiso «puede aceptar riesgos» del perfil

**Programa de seguridad** (vista `programa`)
- Lectura: `programa_listar`, `programa_detalle`, `programa_avance`, `programa_personas_listar`
- Escritura: `programa_crear_actividad`, `programa_actualizar_actividad`, `programa_registrar_realizacion`

**Capacitación** (vista `capacitacion`)
- Lectura: `capacitaciones_catalogos`, `capacitaciones_listar`, `capacitacion_detalle`, `capacitaciones_por_vencer`
- Escritura: `capacitacion_crear`, `capacitacion_actualizar`, `capacitacion_registrar_asistencia`, `trabajador_curso_registrar`

**Control documental** (vista `documentos`)
- Lectura: `documentos_listar`, `documento_detalle`, `documentos_vencidos`
- Escritura: `documento_crear`, `documento_actualizar`

**Accidentabilidad** (vista `accidentabilidad`)
- Lectura: `accidentabilidad_catalogos`, `accidentes_listar`, `accidente_detalle`, `investigaciones_transito_listar`, `investigacion_transito_detalle`
- Escritura:
  - `accidente_registrar`, `incidente_registrar`, `accidente_actualizar`: mismas validaciones de la app (criterio SUSESO si es grave, fecha de la DIAT/DIEP) y avisos legales de suspensión y notificación.
  - `investigacion_accidente_guardar`: la investigación formal, una por accidente.
  - `arbol_causas_crear`, `arbol_causas_actualizar`: los hechos se citan entre sí por referencia; se rechazan ciclos y se avisa si hay palabras de juicio.
  - `investigacion_transito_crear`, `investigacion_transito_actualizar`: cargan el μ de la superficie y el tiempo de reacción como el formulario, responden la lista de verificación por número de ítem y **agregan fotos** (JPG/PNG/WEBP, máx. 1,5 MB c/u, 6 por llamada, 20 en total). Devuelven lo que falta para completar la investigación (la misma lista de la app) y el cálculo de velocidad y distancias.
- **Dotación y DS 67:**
  - `dotacion_listar`, `dotacion_cargar`: carga en bloque la dotación mensual (por ejemplo, los 36 meses del simulador DS 67 de la mutualidad). Las horas-hombre son opcionales: quedan en 0 para completarlas después en la app. Acepta meses con 0 trabajadores, que cuentan en el promedio igual que en la mutualidad. No sobrescribe una dotación distinta sin `sobrescribir=true` y conserva las horas-hombre ya registradas.
  - `ds67_evaluacion`, `ds67_evaluacion_guardar`: calcula la evaluación como la app y guarda los datos que informa la mutualidad (factor y tasa de invalideces y muertes, corrección de días perdidos por período).
- **Videos:** la app no guarda videos. Desde Claude Code se pueden extraer cuadros de un video y adjuntarlos como fotos de la investigación de tránsito; desde claude.ai, las fotos se adjuntan en la app.

**Trabajadores**
- Lectura (cualquiera de los módulos anteriores o `config`): `trabajadores_listar`, `trabajador_detalle`
- Escritura (solo vista `config`): `trabajador_crear`, `trabajador_actualizar`

### Reglas acordadas
- **Documento vencido:** la versión vigente cuya fecha de revisión ya pasó. Si no tiene fecha de revisión, la que tiene más de 12 meses desde su fecha de actualización o confección.
- **Trabajadores:** el RUT se muestra.
- **Perfil Administrador** (`esAdmin`): ve todo.
- **Usuario sin perfil:** no ve nada. Es más estricto que la app, que sin sistema de sesión muestra todo.

### Validaciones
Son las mismas de la app y producen los mismos efectos:
- **Historial de la matriz:** cada cambio en MIPER o Plan de acción queda en `matrizHistorial`.
- **Catálogo del rubro:** los procesos, actividades, categorías y peligros nuevos se agregan, igual que en la app.
- **Hoja mensual:** se crea la del responsable en Programa y Capacitación cuando falta.
- **Capacitación:** se sincronizan los convocados según «Dirigida a» y se marca realizada automáticamente cuando corresponde.
- **Cursos obligatorios:** el vencimiento se calcula con la vigencia del curso.

### Cambios concurrentes
Las herramientas `*_actualizar*` exigen `version_esperada`, que es el `_version` que devuelve la herramienta de detalle. Si otra persona modificó el registro entretanto, la actualización se rechaza en vez de sobrescribir ese cambio.

## Seguridad
- **Autenticación:**
  - OAuth 2.1 con PKCE S256 obligatorio.
  - Registro dinámico de clientes, solo con la URL de retorno `https://claude.ai/api/mcp/auth_callback`. Se cambia con la variable `MCP_REDIRECT_URIS`.
  - Códigos de un solo uso, de 10 minutos.
- **Tokens:**
  - El de acceso dura 1 hora y el de renovación 30 días.
  - El de renovación rota en cada uso, y si se reutiliza uno ya usado, se revoca toda la familia de tokens.
  - Se guardan solo sus hash.
- **Login:** reutiliza las reglas de `POST /api/auth/login` (empresas pendientes, usuarios inactivos, selección de empresa) y lo hace sin que la clave se reenvíe ni quede en la página.
- **Intentos fallidos:** se bloquean 15 minutos tras 10 fallos con un mismo correo o 20 desde una misma IP. Los ingresos exitosos no cuentan.
- **En cada llamada** se vuelven a leer el usuario, el perfil y la empresa: desactivar a alguien o quitarle una vista rige de inmediato.
- **Alcances:**
  - `lectura` siempre se otorga.
  - `escritura` lo marca la persona al conectar. Sin él, las herramientas de escritura no aparecen.
- **Origen:** `/mcp` rechaza solicitudes con un encabezado `Origin` que no sea claude.ai o claude.com (`MCP_ORIGENES_PERMITIDOS`).
- **Adjuntos en base64:** nunca se devuelven a Claude y en la auditoría quedan solo como hash y tamaño.

## Auditoría
Cada escritura deja una fila en `auditoria_escrituras` dentro de la misma transacción: si no queda auditada, el cambio no se guarda. La fila registra:
- empresa, usuario (id y nombre) y cliente OAuth
- herramienta, store, id del registro y operación
- valor anterior y nuevo completos, más los campos que cambiaron

La tabla está fuera de `records`, así que ninguna ruta de la app puede leerla ni modificarla. Se consulta con `auditoria_listar` (solo Administrador) o por SQL.

## Pruebas
```bash
npm test                     # 65 pruebas (unitarias + integración OAuth/MCP/permisos/módulos/auditoría)
node scripts/paridad-app.js ../prevencion-riesgos-app-pehuen/index.html [foto.jpg]   # paridad con la app real (Playwright)
```
- **Base de datos:** las pruebas usan una base PostgreSQL **local** desechable (`postgres://pehuen_test:pehuen_test@localhost/pehuen_test`, o la de `TEST_DATABASE_URL`) que **se borra entera** en cada corrida. Por eso se niegan a correr si el servidor no es `localhost` o si el nombre de la base no contiene «test».
- **Paridad con la app:** `scripts/paridad-app.js` escribe con el conector y comprueba, en el `index.html` real, que la app muestra esos registros, calcula los mismos niveles y estados, y puede seguir editándolos.

## Staging gratuito (Render)
`render.staging.yaml` crea un servicio y una base de datos **aparte de producción**, ambos con `plan: free` explícito y solo con datos inventados (`scripts/datos-prueba.js`).

**Resguardos del sembrado:** solo corre con `SEMBRAR_DATOS_PRUEBA=true`, y además se niega a sembrar en cualquiera de estos casos:
- el servicio se llama como el de producción
- la base ya tiene algún registro que no sea de prueba
- falta `CLAVE_DATOS_PRUEBA`

**Datos de prueba:** dos empresas ficticias.
- Usuarios `admin`, `prevencionista`, `supervisor`, `trabajador` y `capacitacion` con correo `<rol>@andes.pehuen-prueba.example` o `<rol>@sur.pehuen-prueba.example`.
- `multi@pehuen-prueba.example`, que existe en las dos empresas.
- Todos usan la clave `CLAVE_DATOS_PRUEBA`, que Render genera y se ve en *Environment*.

**Limitaciones del plan gratuito:**
- El servicio se suspende tras unos 15 minutos sin uso; el primer acceso tarda cerca de un minuto en despertar.
- La base gratuita expira a los 30 días. Se borra y se vuelve a crear; los datos se siembran solos.
- Render permite una sola base gratuita activa por cuenta.

## Agregar un módulo (fase 2)
1. **Reglas:** copia las validaciones y los efectos de la app a `mcp/dominio/<modulo>.js`, indicando de qué función de `index.html` sale cada regla.
2. **Herramientas:** créalas en `mcp/herramientas/<modulo>.js` con `herramienta({...})`.
   - Elige el permiso en `PERMISOS` (`mcp/contexto.js`) según la vista de la app.
   - Escribe siempre a través de `datos.transaccion()`, que deja la auditoría.
   - Nunca expongas un borrado.
3. **Registro:** agrega el módulo en `mcp/index.js`.
4. **Pruebas:** escríbelas en `test/` y agrega una verificación en `scripts/paridad-app.js`.

## Limitaciones conocidas
- **Cambios pisados desde la app:** la app guarda objetos completos desde su caché del navegador. Si alguien tiene la app abierta desde antes y guarda ese mismo registro, puede pisar un cambio hecho por Claude. El conector sí detecta lo contrario (`version_esperada`). Corregirlo del todo requiere cambiar la app.
- **Archivos adjuntos** (respaldos, certificados, PDF de documentos): se suben desde la app.
- **Usuarios sin correo:** no pueden conectar Claude, porque el login antiguo por `usuarioId` no sirve para OAuth.
- **Respaldos del programa:** `programa_registrar_realizacion` con `fecha_realizada: null` quita la fecha pero conserva el respaldo adjunto. La app, en cambio, lo borra.
- **Convocados de una capacitación:** al cambiar «Dirigida a», se quitan de la lista los convocados que no asistieron y ya no corresponden, igual que en la app. Quienes asistieron nunca se quitan.
