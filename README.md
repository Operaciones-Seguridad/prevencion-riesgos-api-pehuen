# Backend — Sistema de Gestión Prevención de Riesgos (Pehuén)

API real (Node.js + PostgreSQL) que reemplaza el almacenamiento local
(IndexedDB) de la app por una base de datos compartida, con
autenticación real.

## Requisitos
- Cuenta gratuita en [Render](https://render.com/) (puedes crearla con tu cuenta de GitHub).
- Repositorio en GitHub con este contenido.

## Despliegue en Render (recomendado: Blueprint)
1. Sube el contenido de esta carpeta a un repositorio nuevo en GitHub.
2. En Render, click "New" → "Blueprint" y selecciona ese repositorio.
   Render detecta automáticamente `render.yaml` y crea:
   - Un Web Service (`prevencion-riesgos-api-pehuen`) con Node.js.
   - Una base de datos PostgreSQL (`prevencion-riesgos-db-pehuen`).
   - La variable `DATABASE_URL` conectada automáticamente a esa base de datos.
   - La variable `JWT_SECRET` generada automáticamente (clave para firmar las sesiones).
3. Después del primer despliegue, entra a la variable de entorno `CORS_ORIGIN`
   del servicio y cámbiala de `"*"` a la dirección exacta de tu sitio
   (por ejemplo `https://tu-sitio.netlify.app`), para que solo tu sitio
   pueda usar esta API.
4. Copia la URL pública que te da Render para el servicio (algo como
   `https://prevencion-riesgos-api-pehuen.onrender.com`).

## Conectar la app (app.html) a este backend
Abre `app.html`, busca la línea:
```js
const API_BASE_URL = "";
```
y reemplázala por tu URL de Render:
```js
const API_BASE_URL = "https://prevencion-riesgos-api-pehuen.onrender.com";
```
Vuelve a subir ese archivo a tu hosting estático (Netlify/Vercel/etc.).
Si dejas `API_BASE_URL` vacío, la app sigue funcionando exactamente
igual que antes (sin backend, guardando todo solo en el navegador).

## Primer ingreso
La primera vez que el servidor arranca con una base de datos vacía,
crea automáticamente:
- Usuario: **Administrador del sistema**
- Clave: **admin123**

Cambia esta clave (o crea tu usuario real y elimina este) desde
Configuración → Gestión de accesos apenas entres, ya que es una
credencial pública documentada aquí.

## Notas técnicas
- Sin dependencias externas más allá de `pg` (cliente de PostgreSQL):
  el servidor usa los módulos nativos `http` y `crypto` de Node, sin
  Express/bcrypt/jsonwebtoken, para mantenerlo simple y fácil de auditar.
- Un único modelo de datos genérico (tabla `records`, columnas
  `store` + `id` + `data JSONB`) que refleja los mismos "stores" que
  la app ya usaba en IndexedDB — no requiere rediseñar el modelo de
  datos de la app.
- Las claves de usuario se guardan con hash (scrypt), nunca en texto
  plano, y nunca se devuelven al navegador.
- **Limitación conocida:** cualquier usuario autenticado (con sesión
  válida) puede leer/escribir cualquier módulo vía la API; el control
  de qué pestañas ve cada perfil sigue siendo solo de interfaz, igual
  que en el prototipo original. Para restringir por rol también a
  nivel de servidor, se requeriría una fase adicional de desarrollo.
