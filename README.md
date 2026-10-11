# TESTIMONIOS TELEGRAM

Panel privado para generar y descargar composiciones de chat con el sistema local configurado en el proyecto.

## Funciones

- Dos cuentas independientes para Alexander y Jorge.
- Galería, trabajos y frases separados por usuario.
- Diez imágenes automáticas al comenzar cada día en `America/Lima`.
- Generaciones adicionales de 1 a 50 imágenes mediante una cola persistente.
- Galería agrupada por fecha y descarga individual en móvil o escritorio.
- Banco privado de frases con acciones para agregar y eliminar.

## Configuración

Copia `.env.example` a `.env` y completa:

```env
ALEXANDER_EMAIL=alexander@testimoniostelegram.com
ALEXANDER_PASSWORD=una-contraseña-privada
JORGE_EMAIL=jorge@testimoniostelegram.com
JORGE_PASSWORD=otra-contraseña-privada
SESSION_SECRET=un-secreto-largo-y-aleatorio
PORT=3000
APP_TIMEZONE=America/Lima
APP_PORT=3000
COOKIE_SECURE=false
```

Las contraseñas admiten texto o hash bcrypt. En producción usa `COOKIE_SECURE=true` detrás de HTTPS.

## Inicio local

```powershell
npm install
npm start
```

Abre `http://localhost:3000`.

## Docker Compose

```powershell
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

En Dokploy usa `docker-compose.yml` y dirige el dominio al puerto interno `3000`. Los volúmenes `studio-data` y `generated-images` conservan la base de datos y las imágenes.

## Persistencia

- `data/studio.sqlite` guarda sesiones, frases, trabajos y metadatos.
- `generated/` guarda las imágenes terminadas.
- Al reiniciar, los trabajos pendientes se recuperan y continúan en segundo plano.
- El programador crea un solo lote automático de diez imágenes por usuario y fecha.

## API principal

- `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `GET /api/images`: galería del usuario agrupada por fecha.
- `POST /api/generation-jobs`: crea un trabajo con `{ "quantity": 1..50 }`.
- `GET /api/generation-jobs` y `GET /api/generation-jobs/:id`: progreso privado.
- `GET /api/phrases`, `POST /api/phrases`, `DELETE /api/phrases/:id`
- `GET /api/images/:id/file?download=1`: descarga privada.
