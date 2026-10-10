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

## Persistencia y seguridad

- `data/studio.sqlite` guarda metadatos y sesiones.
- `generated/` guarda las imágenes.
- Ambos directorios y `.env` están excluidos de Git.
- Se requiere HTTPS en producción para las cookies seguras de sesión.
- Respaldar `data/` y `generated/` conserva la galería.
- La contraseña también admite un hash bcrypt; si `LOGIN_PASSWORD` comienza con `$2`, se compara como bcrypt.

## Generación automática

La aplicación programa diez composiciones de chat ficticias al día, espaciadas cada 2 h 24 min según `APP_TIMEZONE`. Los trabajos se guardan en SQLite para retomar los pendientes después de un reinicio; cada trabajo puede reintentarse hasta tres veces. Las generaciones manuales siguen disponibles y no sustituyen las automáticas. El botón «Crear con plantilla gratis» abre una vista previa local: permite escoger ganancia o pérdida, una de tres escenas, editar el agradecimiento y la respuesta, y guardar la imagen final en la galería. Las imágenes de trading no consumen la API; las demás escenas pueden usar Gemini.

Las siete capturas proporcionadas por el usuario están guardadas en [`references/trading-history/`](references/trading-history/README.md). El compositor local conserva sus cifras y proporciones, rota tres encuadres, nombres, perfiles gráficos y frases regionales, y ajusta la altura de las burbujas al texto. Usa la fuente Inter embebida, con su licencia en `assets/fonts/OFL.txt`. Dos de los diez trabajos diarios muestran pérdidas de ejemplo dibujadas localmente. Las solicitudes manuales que mencionan trading, XAUUSD, historial, ganancias o pérdidas abren la misma vista previa local; las demás solicitudes manuales pueden usar Gemini.

## Banco de frases

El panel permite añadir, editar y eliminar ejemplos de mensajes para ganancias o pérdidas. Se guardan en `data/studio.sqlite` y se rotan entre las siguientes imágenes creadas con plantilla; también se incluyen como guía en los prompts manuales de trading con IA. No se entrena ningún modelo: se usan las frases guardadas como plantillas de texto. Las variables `{{saludo}}`, `{{tratamiento}}`, `{{profit}}` y `{{cierre}}` se sustituyen con la hora, un tratamiento regional, el resultado simulado y el día. Se pueden añadir alternativas como `[[bro|hermano]]` para variar una frase sin gastar API. Así se evitan importes fijos que no coincidan con la captura.

Las plantillas locales se renderizan con texto y cálculos programados; las generaciones con IA pueden cometer errores de texto o cifras. El panel también permite importar una captura auténtica completa en PNG o JPEG: se guarda exactamente como se recibió, sin editar cifras, texto ni imagen. Revisar cada imagen antes de publicarla.
