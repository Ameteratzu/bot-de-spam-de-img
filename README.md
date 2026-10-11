# Chat Image Studio

Landing privada para generar imágenes de conversaciones ficticias tipo chat de iPhone, basada en las referencias visuales del proyecto. Está pensada para una cuenta compartida por dos personas, con galería privada, generación manual y una programación automática de 10 imágenes diarias. Las imágenes automáticas usan una plantilla local para evitar cargos de la API de imágenes.

## Requisitos

- Node.js 22 o superior
- Una clave de Gemini API de Google AI Studio con acceso al modelo configurado

Google documenta una transición de claves estándar hacia claves de autorización y el rechazo de claves estándar desde septiembre de 2026. Confirma en AI Studio que la clave de producción sea compatible con esa política y restrínge su uso a Gemini API.

## Puesta en marcha

```powershell
Copy-Item .env.example .env
```

Completa `.env`:

- `LOGIN_EMAIL` y `LOGIN_PASSWORD`: credenciales compartidas de acceso.
- `GEMINI_API_KEY`: clave privada de Gemini; no la pongas en el código del navegador.
- `SESSION_SECRET`: secreto largo y aleatorio para firmar sesiones.
- `GEMINI_IMAGE_MODEL`: por defecto `gemini-3.1-flash-lite-image` para generaciones manuales con IA.
- Las diez generaciones automáticas usan siempre el compositor local y no consumen la API de Gemini.
- `APP_TIMEZONE`: zona horaria que define el contador diario; por defecto `America/Lima`.

Para producción, genera una contraseña de sesión segura con:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Instala e inicia:

```powershell
npm install
npm start
```

Abre <http://localhost:3000>. Durante desarrollo, `npm run dev` reinicia el servidor al detectar cambios.

## Docker Compose

Prepara el archivo de variables y levanta el servicio:

```powershell
Copy-Item .env.example .env
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

Abre <http://localhost:3000>. `APP_PORT` permite cambiar el puerto publicado por el archivo local. Los volúmenes `studio-data` y `generated-images` conservan la base de datos y la galería entre reconstrucciones. Para publicar detrás de HTTPS, configura `COOKIE_SECURE=true`; en HTTP local debe permanecer en `false`.

En Dokploy usa únicamente `docker-compose.yml`. El servicio expone internamente el puerto `3000` sin reservar un puerto del servidor; configura el dominio de Dokploy para apuntar al puerto interno `3000`.

Para detener el servicio sin eliminar los datos:

```powershell
docker compose -f docker-compose.yml -f docker-compose.local.yml down
```

## Persistencia y seguridad

- `data/studio.sqlite` guarda metadatos y sesiones.
- `generated/` guarda las imágenes.
- Ambos directorios y `.env` están excluidos de Git.
- Se requiere HTTPS en producción para las cookies seguras de sesión.
- Respaldar `data/` y `generated/` conserva la galería.
- La contraseña también admite un hash bcrypt; si `LOGIN_PASSWORD` comienza con `$2`, se compara como bcrypt.

## Generación automática

La aplicación programa diez composiciones de chat ficticias al día, espaciadas cada 2 h 24 min según `APP_TIMEZONE`. Alterna día y noche por franja: cinco de cada tema. Los trabajos se guardan en SQLite para retomar los pendientes después de un reinicio; cada trabajo puede reintentarse hasta tres veces. Las generaciones manuales siguen disponibles y no sustituyen las automáticas. Su tema alterna con un contador persistente; al editar una vista previa se conserva el tema y el archivo guardado usa exactamente esa escena. El botón «Crear con plantilla gratis» permite escoger ganancia o pérdida, una de tres escenas, editar el agradecimiento y la respuesta, y guardar la imagen final en la galería. Las imágenes de trading no consumen la API; las demás escenas pueden usar Gemini.

Las ocho capturas proporcionadas por el usuario están guardadas en [`references/trading-history/`](references/trading-history/README.md). Las siete referencias claras tienen versiones oscuras en `references/trading-history/dark/`; se recolorean los píxeles a la misma resolución, sin reconstruir cifras. El tema nocturno rota cinco fondos locales de `assets/wallpapers/`, incluidos los cuatro enlaces aportados; el fondo elegido se guarda en la escena. El compositor local conserva cifras y proporciones, rota tres encuadres, nombres, 100 perfiles ficticios de `assets/profiles/curated/` y frases, y ajusta la altura de las burbujas al texto. La colección combina retratos fotográficos, perfiles anime y algunos paisajes. El perfil seleccionado se guarda en cada escena; la rotación usa recursos coherentes con el nombre del contacto. Las respuestas de ganancia alternan entre texto y un sticker del paquete local cuando cabe sin tapar el resultado. La hora y el saludo corresponden al tema de la escena. Usa la fuente Inter embebida, con su licencia en `assets/fonts/OFL.txt`. Dos de los diez trabajos diarios muestran pérdidas de ejemplo dibujadas localmente. Las solicitudes manuales que mencionan trading, XAUUSD, historial, ganancias o pérdidas abren la misma vista previa local; las demás solicitudes manuales pueden usar Gemini.

## Banco de frases

El panel permite añadir, editar y eliminar ejemplos de mensajes para ganancias o pérdidas. Se guardan en `data/studio.sqlite` y se rotan entre las siguientes imágenes creadas con plantilla. No se entrena ningún modelo: se usan las frases guardadas como plantillas de texto. Las variables `{{saludo}}`, `{{tratamiento}}`, `{{profit}}`, `{{cierre}}` y `{{emoji}}` se sustituyen con la hora, un tratamiento que alterna entre jefe, líder y máster, el resultado de la captura, el día y un emoji contextual. En la vista previa puede indicarse un nombre o tratamiento concreto para el mensaje. Se pueden añadir alternativas como `[[jefe|líder]]` para variar una frase sin gastar API. La rotación se guarda en SQLite y recorre también las seis nuevas guías de [mensajes recibidos](prompts/guias-mensajes.md). Así se evitan importes fijos que no coincidan con la captura.

Las plantillas locales se renderizan con texto y cálculos programados; las generaciones con IA pueden cometer errores de texto o cifras. El panel también permite importar una captura auténtica completa en PNG o JPEG: se guarda exactamente como se recibió, sin editar cifras, texto ni imagen. Revisar cada imagen antes de publicarla.
