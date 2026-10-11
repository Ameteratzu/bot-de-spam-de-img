import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import { ZipArchive } from 'archiver';
import { rateLimit } from 'express-rate-limit';
import sharp from 'sharp';
import { renderTelegramChat, conversationText } from './telegram-compositor.js';
import { themeForAutomaticSlot, themeForManualCursor } from './scene-theme.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const TIME_ZONE = process.env.APP_TIMEZONE || 'America/Lima';
const COOKIE_SECURE = process.env.COOKIE_SECURE === undefined
  ? process.env.NODE_ENV === 'production'
  : process.env.COOKIE_SECURE === 'true';
const ALEXANDER_EMAIL = (process.env.ALEXANDER_EMAIL || 'alexander@testimoniostelegram.com').trim().toLowerCase();
const JORGE_EMAIL = (process.env.JORGE_EMAIL || 'jorge@testimoniostelegram.com').trim().toLowerCase();
const DATA_DIR = path.join(__dirname, 'data');
const IMAGE_DIR = path.join(__dirname, 'generated');
const REFERENCE_DIR = path.join(__dirname, 'references', 'trading-history');
const DB_PATH = path.join(DATA_DIR, 'studio.sqlite');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(IMAGE_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expired_idx ON sessions(expired);
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    display_name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    day_key TEXT NOT NULL,
    mime_type TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS daily_generation_jobs (
    day_key TEXT NOT NULL,
    slot INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    image_id TEXT,
    error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (day_key, slot)
  );
  CREATE TABLE IF NOT EXISTS phrase_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outcome TEXT NOT NULL CHECK (outcome IN ('gain', 'loss')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS phrase_library_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS template_previews (
    token TEXT PRIMARY KEY,
    scene_json TEXT NOT NULL,
    prompt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Existing installations started with one shared gallery. Preserve those
// records for Alexander, then isolate all new records by authenticated email.
ensureColumn('images', 'owner_email', `TEXT NOT NULL DEFAULT '${ALEXANDER_EMAIL.replaceAll("'", "''")}'`);
ensureColumn('images', 'batch_id', 'TEXT');
ensureColumn('images', 'downloaded_at', 'TEXT');
ensureColumn('template_previews', 'owner_email', `TEXT NOT NULL DEFAULT '${ALEXANDER_EMAIL.replaceAll("'", "''")}'`);
ensureColumn('phrase_templates', 'owner_email', `TEXT NOT NULL DEFAULT '${ALEXANDER_EMAIL.replaceAll("'", "''")}'`);
db.exec(`
  CREATE INDEX IF NOT EXISTS images_owner_created_idx ON images(owner_email, created_at DESC);
  CREATE INDEX IF NOT EXISTS previews_owner_idx ON template_previews(owner_email);
  CREATE TABLE IF NOT EXISTS user_daily_generation_jobs (
    owner_email TEXT NOT NULL,
    day_key TEXT NOT NULL,
    slot INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    image_id TEXT,
    error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_email, day_key, slot)
  );
  CREATE TABLE IF NOT EXISTS generation_batches (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL,
    day_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('automatic', 'manual')),
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 50),
    completed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_automatic_batch_per_day ON generation_batches(owner_email, day_key, kind) WHERE kind = 'automatic';
  CREATE INDEX IF NOT EXISTS generation_batches_owner_created_idx ON generation_batches(owner_email, created_at DESC);
  CREATE INDEX IF NOT EXISTS images_owner_day_idx ON images(owner_email, day_key, created_at DESC);
  CREATE INDEX IF NOT EXISTS images_batch_idx ON images(batch_id);
`);

const defaultPhrases = [
  ['gain', '{{saludo}}, {{tratamiento}}. Cerré el día en positivo {{emoji}} con {{profit}}. Gracias por tus consejos; me ayudaron a seguir el plan.'],
  ['gain', 'Amigo querido, muchas bendiciones. Hoy terminé con {{profit}} {{emoji}} y estoy contento con el avance de la IA. Gracias por acompañarme.'],
  ['gain', '{{saludo}}, [[líder|bro]]. Las operaciones cerraron con {{profit}} {{emoji}}. Gracias por ayudarme a tener paciencia y cuidar cada entrada.'],
  ['gain', '{{saludo}}, {{tratamiento}}. Me alegró cerrar con {{profit}} {{emoji}}. Gracias por tu tiempo y por acompañarme en el proceso.'],
  ['loss', '{{saludo}}, {{tratamiento}}. Hoy cerré con {{profit}} {{emoji}}. Me toca revisar las entradas; gracias por ayudarme a volver al plan.'],
  ['loss', '{{saludo}}, líder. La sesión terminó en {{profit}} {{emoji}}. Gracias por ayudarme a revisar cada detalle y ver qué puedo mejorar.']
];
const guidancePhrases = [
  '{{saludo}}, líder. Estoy encantado de trabajar con usted y aprender a usar la herramienta. Al principio tenía mis dudas, pero me animé a probarla y hoy cerré con {{profit}}. Gracias por guiarme {{emoji}}.',
  '{{saludo}}, {{tratamiento}}. Estoy demasiado emocionado: hoy cerré con {{profit}}. Lo mejor es compartir este proceso con una comunidad que me ayuda a aprender. ¡Vamos por más, líder! {{emoji}}',
  'Hola, hermano. Comencé con muchas dudas y mira cómo voy avanzando: {{profit}} en esta sesión. Gracias por la herramienta y por estar pendiente; quiero seguir aprendiendo a seguir mejorando cada día.',
  'Hermano, estoy emocionado con todo lo que estoy aprendiendo. Compartir este proceso con la comunidad me motiva muchísimo. Cerré con {{profit}}; seguimos enfocados, líder {{emoji}}.',
  'Líder, tenía que escribirle. Qué bien se siente entender cosas que antes me parecían complicadas. Gracias por la paciencia y por compartir sus conocimientos. Hoy cerré con {{profit}}. ¡Vamos por más! {{emoji}}',
  'Hermano, me alegra dedicarle tiempo a aprender esto. Hoy cerré con {{profit}} y quería darle las gracias por estar pendiente. Seguimos firmes y aprendiendo {{emoji}}.'
];
db.transaction(() => {
  if (db.prepare("SELECT value FROM phrase_library_meta WHERE key = 'defaults_seeded'").get()) return;
  const insert = db.prepare('INSERT INTO phrase_templates (outcome, body, created_at) VALUES (?, ?, ?)');
  const now = new Date().toISOString();
  for (const [outcome, body] of defaultPhrases) insert.run(outcome, body, now);
  db.prepare("INSERT INTO phrase_library_meta (key, value) VALUES ('defaults_seeded', '1')").run();
})();
const phraseUpgrade = db.prepare('UPDATE phrase_templates SET body = ? WHERE body = ?');
phraseUpgrade.run(defaultPhrases[0][1], '{{saludo}}, {{tratamiento}}. Bendiciones. Cierro la semana en positivo con la herramienta de IA 🤖 y {{profit}} de beneficio en esta simulación. Gracias por tu ayuda, mentor; me motivó seguir el plan.');
phraseUpgrade.run(defaultPhrases[1][1], '{{saludo}}, amigo querido. Muchas bendiciones: otro día más con un resultado positivo de {{profit}} en esta simulación. Estoy emocionado con esta IA, ¡waooo! Gracias por acompañarme.');
phraseUpgrade.run(defaultPhrases[2][1], '{{saludo}}, líder. Te comparto las operaciones que dejé corriendo: cerraron con {{profit}} de beneficio simulado. Me emocionó verlo; gracias por ayudarme a tener paciencia.');
db.prepare("UPDATE phrase_templates SET body = REPLACE(REPLACE(REPLACE(REPLACE(body, 'en esta simulación', ''), 'En esta simulación, ', ''), 'beneficio simulado', 'beneficio'), 'resultado simulado', 'resultado') WHERE body LIKE '%simulaci%' OR body LIKE '%simulado%'").run();
// Compact only the known built-in entries from earlier versions. Exact body
// matching preserves any phrases the user has edited or added in the panel.
const compactPhraseUpgrade = db.prepare('UPDATE phrase_templates SET body = ? WHERE body = ?');
[
  [defaultPhrases[0][1], '{{saludo}}, {{tratamiento}}. [[Bendiciones|Qué alegría]]. {{cierre}} en positivo con la herramienta de IA 🤖 y {{profit}} de beneficio . Gracias por tu ayuda, mentor; me motivó seguir el plan.'],
  [defaultPhrases[1][1], '{{saludo}}, amigo querido. Muchas bendiciones: otro día más con un resultado positivo de {{profit}} . Estoy emocionado con esta IA, [[¡waooo!|¡qué emoción!]] Gracias por acompañarme.'],
  [defaultPhrases[2][1], '{{saludo}}, [[líder|bro]]. Te comparto las operaciones que dejé corriendo: cerraron con {{profit}} de beneficio. Me emocionó verlo; gracias por ayudarme a tener paciencia.'],
  [defaultPhrases[3][1], '{{saludo}}, {{tratamiento}}. un resultado de {{profit}} me alegró el día. Agradecido contigo por el tiempo y los consejos; eres un gran apoyo.'],
  [defaultPhrases[4][1], '{{saludo}}, {{tratamiento}}. Hoy el resultado fue {{profit}}. Me frustró un poco, pero gracias por ayudarme a revisar las entradas y volver al plan con más calma.'],
  [defaultPhrases[5][1], '{{saludo}}, líder. Esta sesión simulada terminó en {{profit}}. Gracias por acompañarme a entender el error; aprendí más revisando cada detalle que mirando solo el resultado.']
].forEach(([updated, previous]) => compactPhraseUpgrade.run(updated, previous));

// Add the new guidance once on existing installations. The marker also keeps
// phrases the user later edits or deletes from being restored at startup.
db.transaction(() => {
  const key = 'guidance_phrases_2026_10_10';
  if (db.prepare('SELECT value FROM phrase_library_meta WHERE key = ?').get(key)) return;
  const exists = db.prepare('SELECT id FROM phrase_templates WHERE outcome = ? AND body = ?');
  const insert = db.prepare('INSERT INTO phrase_templates (outcome, body, created_at) VALUES (?, ?, ?)');
  const now = new Date().toISOString();
  for (const body of guidancePhrases) {
    if (!exists.get('gain', body)) insert.run('gain', body, now);
  }
  db.prepare('INSERT INTO phrase_library_meta (key, value) VALUES (?, ?)').run(key, '1');
})();

function nextPhraseIndex(loss, advance = true, ownerEmail = ALEXANDER_EMAIL) {
  return db.transaction(() => {
    const outcome = loss ? 'loss' : 'gain';
    const key = `phrase_cursor_${ownerEmail}_${outcome}`;
    const saved = db.prepare('SELECT value FROM phrase_library_meta WHERE key = ?').get(key);
    const count = db.prepare('SELECT COUNT(*) AS count FROM phrase_templates WHERE owner_email = ? AND outcome = ?').get(ownerEmail, outcome).count;
    const start = loss ? 0 : Math.max(0, count - guidancePhrases.length);
    const index = saved ? Number.parseInt(saved.value, 10) || 0 : start;
    if (advance) {
      db.prepare('INSERT INTO phrase_library_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(index + 1));
    }
    return index;
  })();
}
[
  [defaultPhrases[0][1], '{{saludo}}, {{tratamiento}}. Cerré el día en positivo con {{profit}}. Gracias por tus consejos; me ayudaron a seguir el plan {{emoji}}.'],
  [defaultPhrases[1][1], 'Amigo querido, muchas bendiciones. Hoy terminé con {{profit}} y estoy contento con el avance de la IA {{emoji}}. Gracias por acompañarme.'],
  [defaultPhrases[2][1], '{{saludo}}, [[líder|bro]]. Las operaciones cerraron con {{profit}}. Gracias por ayudarme a tener paciencia y cuidar cada entrada.'],
  [defaultPhrases[3][1], '{{saludo}}, {{tratamiento}}. Me alegró cerrar con {{profit}} {{emoji}}. Gracias por tu tiempo y por acompañarme en el proceso.'],
  [defaultPhrases[4][1], '{{saludo}}, {{tratamiento}}. Hoy cerré con {{profit}} {{emoji}}. Me toca revisar las entradas; gracias por ayudarme a volver al plan.'],
  [defaultPhrases[5][1], '{{saludo}}, líder. La sesión terminó en {{profit}} {{emoji}}. Gracias por ayudarme a revisar cada detalle y ver qué puedo mejorar.']
].forEach(([updated, previous]) => compactPhraseUpgrade.run(updated, previous));

// Give each account its own initial copy. Existing shared phrases belong to
// Alexander and are copied once to Jorge; all subsequent changes are private.
db.transaction(() => {
  const key = 'phrases_split_by_owner_v1';
  if (db.prepare('SELECT value FROM phrase_library_meta WHERE key = ?').get(key)) return;
  db.prepare('UPDATE phrase_templates SET owner_email = ? WHERE owner_email IS NULL OR owner_email = ?').run(ALEXANDER_EMAIL, '');
  const existing = db.prepare('SELECT outcome, body, created_at FROM phrase_templates WHERE owner_email = ? ORDER BY id').all(ALEXANDER_EMAIL);
  const insert = db.prepare('INSERT INTO phrase_templates (outcome, body, created_at, owner_email) VALUES (?, ?, ?, ?)');
  for (const phrase of existing) insert.run(phrase.outcome, phrase.body, phrase.created_at, JORGE_EMAIL);
  db.prepare('INSERT INTO phrase_library_meta (key, value) VALUES (?, ?)').run(key, '1');
})();

// Keep previously saved starter phrases aligned with the current tone.
for (const [from, to] of [
  ['con cabeza fría y cuidando el riesgo', 'con constancia y mucha disciplina'],
  ['con cabeza fría y manteniendo la disciplina', 'con constancia y mucha disciplina'],
  ['manejar mejor el riesgo', 'seguir mejorando cada día'],
  ['revisando el riesgo', 'revisando cada detalle'],
  ['revisar el riesgo', 'revisar cada detalle'],
  ['cuidando el riesgo', 'manteniendo la disciplina'],
  ['atentos al riesgo', 'enfocados en el proceso'],
  ['buen manejo del riesgo', 'mucha disciplina']
]) {
  db.prepare('UPDATE phrase_templates SET body = REPLACE(body, ?, ?) WHERE body LIKE ?').run(from, to, `%${from}%`);
}
// Migrate the exact built-in templates saved by earlier releases to the
// contextual emoji placeholder; user-edited phrase bodies remain untouched.
[
  [defaultPhrases[0][1], '{{saludo}}, {{tratamiento}}. Cerré el día en positivo con {{profit}}. Gracias por tus consejos; me ayudaron a seguir el plan 🤖.'],
  [defaultPhrases[1][1], 'Amigo querido, muchas bendiciones. Hoy terminé con {{profit}} y estoy contento con el avance de la IA 🤖. Gracias por acompañarme.'],
  [defaultPhrases[2][1], '{{saludo}}, [[líder|bro]]. Las operaciones cerraron con {{profit}}. Gracias por ayudarme a tener paciencia y cuidar cada entrada.'],
  [defaultPhrases[3][1], '{{saludo}}, {{tratamiento}}. Me alegró cerrar con {{profit}}. Gracias por tu tiempo y por acompañarme en el proceso.'],
  [defaultPhrases[4][1], '{{saludo}}, {{tratamiento}}. Hoy cerré con {{profit}}. Me toca revisar las entradas; gracias por ayudarme a volver al plan.'],
  [defaultPhrases[5][1], '{{saludo}}, líder. La sesión terminó en {{profit}}. Gracias por ayudarme a revisar cada detalle y ver qué puedo mejorar.']
].forEach(([updated, previous]) => compactPhraseUpgrade.run(updated, previous));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '20kb' }));

class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.database = database;
    this.getStatement = database.prepare('SELECT sess, expired FROM sessions WHERE sid = ?');
    this.setStatement = database.prepare('INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired');
    this.destroyStatement = database.prepare('DELETE FROM sessions WHERE sid = ?');
    this.pruneStatement = database.prepare('DELETE FROM sessions WHERE expired <= ?');
  }
  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid);
      if (!row) return callback(null, null);
      if (row.expired <= Date.now()) {
        this.destroyStatement.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }
  set(sid, sess, callback = () => {}) {
    try {
      const maxAge = sess.cookie?.maxAge ?? 7 * 24 * 60 * 60 * 1000;
      this.setStatement.run(sid, JSON.stringify(sess), Date.now() + maxAge);
      if (Math.random() < 0.02) this.pruneStatement.run(Date.now());
      callback(null);
    } catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) {
    try { this.destroyStatement.run(sid); callback(null); } catch (error) { callback(error); }
  }
}
app.use(session({
  store: new SQLiteSessionStore(db),
  name: 'chatstudio.sid',
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const names = [
  'Sofía', 'Mateo', 'Valentina', 'Santiago', 'Camila', 'Sebastián', 'Luciana',
  'Gabriel', 'Isabella', 'Nicolás', 'Mariana', 'Daniel', 'Antonella', 'Joaquín',
  'Alejandra', 'Emilio', 'Renata', 'Andrés', 'Victoria', 'Thiago', 'Mía', 'Samuel'
];
const emojis = ['✨', '🌟', '🤖', '💬', '🚀', '🌻', '🦋', '🎨', '☀️', '💫', ''];
const tradeReferences = [
  { file: '01.png', rows: 9, side: 'buy', topHeight: 1030, profitCents: 22095, swapCents: 0 },
  { file: '02.png', rows: 3, side: 'buy', topHeight: 530, profitCents: 63912, swapCents: -1209 },
  { file: '03.png', rows: 3, side: 'buy', topHeight: 530, profitCents: 37737, swapCents: -1059 },
  { file: '04.png', rows: 3, side: 'buy', topHeight: 530, profitCents: 63264, swapCents: -1512 },
  { file: '05.png', rows: 2, side: 'buy', topHeight: 460, profitCents: 23912, swapCents: -882 },
  { file: '06.png', rows: 3, side: 'sell', topHeight: 530, profitCents: 52782, swapCents: -395 },
  { file: '07.png', rows: 4, side: 'buy', topHeight: 660, profitCents: 27352, swapCents: -2824 },
  { file: '08-night.png', rows: 4, side: 'buy', topHeight: 900, profitCents: 31971, swapCents: -304 }
];
const maleContactNames = [
  'Mateo', 'Andrés', 'Daniel', 'Nicolás', 'Joaquín', 'Gabriel', 'Emilio', 'Sebastián', 'Alejandro', 'Carlos',
  'Santiago', 'Samuel', 'Leonardo', 'Martín', 'Adrián', 'Diego', 'Fernando', 'Felipe', 'Mauricio', 'Ricardo',
  'Javier', 'Miguel', 'Ángel', 'David', 'Esteban', 'Tomás', 'Cristian', 'Jonathan', 'Manuel', 'Eduardo',
  'Rafael', 'Rodrigo', 'Antonio', 'Francisco', 'Luis', 'José', 'Víctor', 'Óscar', 'Bruno', 'Thiago'
];
const femaleContactNames = [
  'Camila', 'Sofía', 'Lucía', 'Valentina', 'Mariana', 'Renata', 'Isabella', 'Paula', 'Natalia', 'Laura',
  'Daniela', 'Gabriela', 'Andrea', 'Carolina', 'Alejandra', 'Fernanda', 'Catalina', 'Juliana', 'Verónica', 'Patricia',
  'Mónica', 'Adriana', 'Lorena', 'Vanessa', 'Melissa', 'Elena', 'Sara', 'Victoria', 'Martina', 'Antonella',
  'Claudia', 'Rocío', 'Noelia', 'Jimena', 'Paola', 'Diana', 'María', 'Ana', 'Mía', 'Amanda'
];
const contactFirstNames = [...maleContactNames, ...femaleContactNames];
const contactSurnames = [
  'Rojas', 'Torres', 'Mejía', 'Paredes', 'Vargas', 'Herrera', 'Muñoz', 'Cruz', 'Salazar', 'Soto',
  'Molina', 'Castillo', 'Núñez', 'Reyes', 'Romero', 'Mendoza', 'Peña', 'Guzmán', 'Peralta', 'Jiménez',
  'García', 'Rodríguez', 'Martínez', 'López', 'González', 'Pérez', 'Sánchez', 'Ramírez', 'Flores', 'Rivera',
  'Gómez', 'Díaz', 'Morales', 'Ortiz', 'Silva', 'Ramos', 'Medina', 'Vega', 'Cabrera', 'Suárez',
  'Acosta', 'Navarro', 'Campos', 'Delgado', 'Guerrero', 'Méndez', 'Valdez', 'Arias', 'Benítez', 'Cordero',
  'Figueroa', 'Miranda', 'Ponce', 'Rosario', 'Santana', 'Espinoza', 'Alvarado', 'Contreras', 'Domínguez', 'Escobar',
  'Fuentes', 'León', 'Montoya', 'Palacios', 'Quiñones', 'Rivas', 'Solano', 'Tapia', 'Villalobos', 'Zambrano'
];
const contactNameFormats = [
  (name) => name,
  (name) => `${name} Comunidad VIP`,
  (name) => `${name.split(' ')[0]} IA`,
  (name) => `${name} VIP`,
  () => 'COMUNIDAD VIP',
  (name) => `${name.split(' ')[0]} Trading`,
  (name) => `${name} Comunidad IA`,
  (name) => `${name.split(' ')[0]} VIP`,
  (name) => `${name} Equipo VIP`,
  (name) => name
];
function contactIdentity(index) {
  const firstName = contactFirstNames[index % contactFirstNames.length];
  let cursor = Math.floor(index / contactFirstNames.length);
  const firstSurnameIndex = cursor % contactSurnames.length;
  cursor = Math.floor(cursor / contactSurnames.length);
  let secondSurnameIndex = cursor % (contactSurnames.length - 1);
  if (secondSurnameIndex >= firstSurnameIndex) secondSurnameIndex += 1;
  const baseName = `${firstName} ${contactSurnames[firstSurnameIndex]} ${contactSurnames[secondSurnameIndex]}`;
  return { baseName, gender: index % contactFirstNames.length < maleContactNames.length ? 'male' : 'female' };
}
const connectionStatuses = [
  'en línea',
  'últ. vez hace 3 minutos',
  'últ. vez hace 9 minutos',
  'últ. vez hace 18 minutos',
  'últ. vez hace 1 hora',
  'últ. vez recientemente'
];
const contextEmojis = {
  gain: ['🤩', '🤑', '🥳', '🤪', '🤯', '🤓', '🤖'],
  loss: ['😳', '🤓', '🥸', '🤖', '🤯', '😠']
};
const replyEmojis = {
  gain: ['🎉', '🏆', '🚀', '🙌', '💪', '🔥'],
  loss: ['🧠', '💡', '📝', '🙏']
};
const avatarColors = ['#456c93', '#8062a8', '#ad725e', '#4c8279', '#ac6e89', '#546d9d', '#9d7c49', '#6b8198', '#8974ad', '#63855d'];
// Contact names are shown without decorative face emojis. Clean records from
// earlier versions as well so the gallery and newly generated chats agree.
const contactEmojiPattern = /[🤖🤩🤑🥳🤪🤯🤓😳🥸😠]/gu;
const savedContactNames = db.prepare('SELECT id, display_name FROM images').all();
const updateContactName = db.prepare('UPDATE images SET display_name = ? WHERE id = ?');
db.transaction(() => {
  for (const row of savedContactNames) {
    const cleanName = row.display_name.replace(contactEmojiPattern, '').replace(/\s{2,}/g, ' ').trim();
    if (cleanName !== row.display_name) updateContactName.run(cleanName, row.id);
  }
})();
const composeSequence = db.prepare('SELECT COUNT(*) AS count FROM images').get().count;
const regionalStyles = [
  { label: 'Perú 🇵🇪', slang: 'causa', reply: '¡Qué alegría, líder! Felicitaciones por seguir el plan; sigamos con constancia.' },
  { label: 'México 🇲🇽', slang: 'qué onda', reply: '¡Eso, bro! Felicidades por la disciplina; vamos paso a paso y con disciplina.' },
  { label: 'Colombia 🇨🇴', slang: 'parce', reply: '¡Eso, parce! Qué gusto ver tu disciplina. Felicitaciones, seguimos firmes.' },
  { label: 'Argentina 🇦🇷', slang: 'che', reply: '¡Bien ahí, che! Felicitaciones por sostener el plan. Seguimos enfocados en el proceso.' },
  { label: 'Chile 🇨🇱', slang: 'bacán', reply: '¡Buena, compa! Felicitaciones por la constancia; sigamos con constancia.' },
  { label: 'Ecuador 🇪🇨', slang: 'ñaño', reply: '¡Qué gusto, ñaño! Felicitaciones por la disciplina. Sigamos con calma.' },
  { label: 'Venezuela 🇻🇪', slang: 'pana', reply: '¡Eso, pana! Felicitaciones por seguir el plan; vamos con calma y mucha disciplina.' }
];
const dominicanReplies = {
  gain: [
    '¡Duro, mi hermano! Me alegra que siguieras el plan. Vamos arriba, paso a paso.',
    '¡Qué duro, mi bro! Felicidades por la disciplina; seguimos paso a paso con calma.',
    '¡Nítido, bro! Buen trabajo manteniendo la disciplina. Seguimos enfocados en el plan.',
    '¡Eso es, mi hermano! Me alegra ver esa constancia; seguimos aprendiendo y celebrando cada avance.'
  ],
  loss: [
    'Tranquilo, mi hermano. Revisamos las entradas con calma y seguimos aprendiendo.',
    'No te me desanimes, bro. Analizamos qué pasó y volvemos al plan sin desesperarnos.',
    'Dale suave, mi hermano. Una sesión no define el proceso; repasamos lo ocurrido y aprendemos.',
    'Está bien, mi loco. Revisamos la operación con calma y seguimos aprendiendo sin salirnos del plan.'
  ]
};
const femaleConversationPhrases = {
  gain: [
    '{{saludo}}, líder. Quería compartirle este resultado porque me hizo muchísima ilusión. Hoy cerré con {{profit}} y cada día me siento más segura usando la herramienta. Gracias por explicarme todo con tanta paciencia {{emoji}}.',
    '{{saludo}}, mentor. Estoy muy contenta con el avance de hoy: {{profit}}. Al principio tenía muchas dudas, pero poco a poco voy entendiendo mejor el proceso. Gracias por estar pendiente {{emoji}}.',
    'Líder, tenía que escribirle para contarle lo emocionada que estoy. Cerré con {{profit}} y siento que todo lo que he venido aprendiendo empieza a dar frutos. De verdad, gracias por acompañarme {{emoji}}.',
    'Hola, líder. Hoy terminé la sesión con {{profit}} y no podía dejar de compartirlo con usted. Me alegra ver que la constancia está dando resultados; sigo aprendiendo muchísimo {{emoji}}.',
    '{{saludo}}, mentor. Estoy feliz con el resultado de hoy: {{profit}}. Más allá del número, me emociona sentir que ya comprendo mejor cada paso. Gracias por su dedicación {{emoji}}.',
    'Líder, qué alegría poder mostrarle este avance. Cerré con {{profit}} y me siento muy agradecida por todo lo que he aprendido dentro de la comunidad. Seguimos adelante {{emoji}}.',
    '{{saludo}}, líder. Le comparto mis operaciones de hoy porque terminé muy contenta con el resultado: {{profit}}. Gracias por la paciencia y por ayudarme a confiar más en el proceso {{emoji}}.',
    'Hola, mentor. Estoy sorprendida y muy emocionada con lo que conseguí hoy: {{profit}}. Cada explicación me ayuda a sentirme más preparada. Gracias por acompañarme en este camino {{emoji}}.'
  ],
  loss: [
    '{{saludo}}, líder. Hoy la sesión terminó en {{profit}}. Me quedé un poco pensativa, pero quería compartirlo con usted para entender qué puedo mejorar. Gracias por seguir pendiente {{emoji}}.',
    'Hola, mentor. El resultado de hoy fue {{profit}}. Aunque no era lo que esperaba, agradezco poder revisarlo y aprender de la experiencia. Gracias por su paciencia {{emoji}}.',
    'Líder, quería contarle cómo me fue hoy. Cerré con {{profit}} y me gustaría entender mejor qué ocurrió. Sé que cada sesión también forma parte del aprendizaje {{emoji}}.',
    '{{saludo}}, líder. Hoy terminé con {{profit}}. Me dio un poco de tristeza al verlo, pero prefiero tomarlo como una oportunidad para seguir aprendiendo. Gracias por orientarme {{emoji}}.'
  ]
};
const femaleMentorReplies = {
  gain: [
    'Me alegra muchísimo leer eso, {{nombre}}. Has sido muy constante y ese avance se nota. ¡Vamos por más! {{emoji}}',
    'Excelente trabajo, {{nombre}}. Qué bonito ver cómo has ido ganando confianza con cada sesión. Seguimos avanzando {{emoji}}',
    'Felicidades, {{nombre}}. Tu dedicación está dando resultados y me alegra acompañarte en este proceso. Seguimos firmes {{emoji}}',
    'Muy bien, {{nombre}}. Se nota todo el empeño que le estás poniendo. Disfruta este avance y continuamos creciendo {{emoji}}'
  ],
  loss: [
    'Gracias por compartirlo, {{nombre}}. Vamos a revisar la sesión con tranquilidad y sacar de ella un buen aprendizaje {{emoji}}',
    'Tranquila, {{nombre}}. Valoro que quieras comprender lo ocurrido; lo revisamos con detalle y seguimos avanzando {{emoji}}',
    'Ánimo, {{nombre}}. Cada sesión nos deja algo para aprender. La revisamos con paciencia y continuamos {{emoji}}'
  ]
};
const pick = (items) => items[crypto.randomInt(items.length)];

function money(cents) { return `${cents < 0 ? '-' : ''}${(Math.abs(cents) / 100).toFixed(2)}`; }

function clockTime(minute, includeMeridiem = false) {
  const normalized = (minute + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const time = `${hour % 12 || 12}:${String(normalized % 60).padStart(2, '0')}`;
  return includeMeridiem ? `${time} ${hour < 12 ? 'AM' : 'PM'}` : time;
}

function phraseForScene(loss, region, summary, variantIndex, contactIndex = 0, theme = 'day', avatarGender = 'male', ownerEmail = ALEXANDER_EMAIL) {
  const outcome = loss ? 'loss' : 'gain';
  const emoji = contextEmojis[outcome][contactIndex % contextEmojis[outcome].length];
  const options = db.prepare('SELECT id, body FROM phrase_templates WHERE owner_email = ? AND outcome = ? ORDER BY id').all(ownerEmail, outcome);
  const fallback = loss ? defaultPhrases[4][1] : defaultPhrases[0][1];
  const genderOptions = femaleConversationPhrases[outcome];
  const selected = avatarGender === 'female'
    ? genderOptions[variantIndex % genderOptions.length]
    : options.length ? options[variantIndex % options.length].body : fallback;
  const optionCount = avatarGender === 'female' ? genderOptions.length : Math.max(options.length, 1);
  const varied = selected.replace(/\[\[([^\[\]]+)\]\]/g, (_match, choices) => {
    const variants = choices.split('|').map((choice) => choice.trim()).filter(Boolean);
    return variants.length ? variants[Math.floor(variantIndex / optionCount) % variants.length] : '';
  });
  const minute = theme === 'night' ? 19 * 60 + (variantIndex * 37 + contactIndex * 13) % 270 : 8 * 60 + (variantIndex * 43 + contactIndex * 17) % 570;
  const hour = Math.floor(minute / 60);
  const saludo = hour >= 5 && hour < 12 ? 'Buenos días' : hour >= 12 && hour < 19 ? 'Buenas tardes' : 'Buenas noches';
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' }).format(new Date());
  const cierre = ['Fri', 'Sat'].includes(weekday) ? 'Cierro la semana' : 'Cierro el día';
  const tratamiento = avatarGender === 'female'
    ? ['líder', 'mentor'][(variantIndex + contactIndex) % 2]
    : ['jefe', 'líder', 'máster'][(variantIndex + contactIndex) % 3];
  const message = varied.replace(/{{(saludo|tratamiento|profit|cierre|emoji)}}/g, (_match, key) => ({
    saludo, tratamiento, profit: `${summary.profitText} USD`, cierre, emoji
  })[key]).replace(/^Buenos (?:días|tardes|noches)\b/i, saludo).replace(/(?<![\p{L}\p{M}])(?:causa|parce|pana|ñaño|che|compa|bro|mi loco)(?![\p{L}\p{M}])/giu, tratamiento).replace(/🤖/g, emoji).replace(/\ben esta simulación\b/gi, '').replace(/\bsimulad[oa]s?\b/gi, '').replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return { message: conversationText(message), emoji, chatTime: clockTime(minute - 2, true), replyTime: clockTime(minute, true), statusTime: clockTime(minute) };
}

function tradeBrief(reference, region, loss = false, variantIndex = 0, contactIndex = 0, layoutIndex = 0, theme = 'day', ownerEmail = ALEXANDER_EMAIL) {
  const lot = crypto.randomInt(4, 9);
  const entry = crypto.randomInt(410000, 424000);
  const date = dayKey().replaceAll('-', '.');
  let profit = 0;
  const sceneRows = Array.from({ length: reference.rows }, (_, index) => {
    const diff = crypto.randomInt(350, 2600);
    const direction = (reference.side === 'buy' ? 1 : -1) * (loss ? -1 : 1);
    const close = entry + direction * diff + crypto.randomInt(-60, 61);
    const amount = (reference.side === 'buy' ? close - entry : entry - close) * lot;
    profit += amount;
    return { side: reference.side, lot, entryText: money(entry), closeText: money(close), amount, amountText: money(amount), time: `${theme === 'night' ? '21' : '10'}:${String(20 + index).padStart(2, '0')}:00` };
  });
  if (!loss) profit = reference.profitCents;
  const swap = loss ? 0 : reference.swapCents;
  const deposit = loss ? Math.max(50000, Math.abs(profit + swap) + 20000) : 0;
  const summary = { depositText: money(deposit), profitText: money(profit), swapText: money(swap), balanceText: money(deposit + profit + swap) };
  const identity = contactIdentity(contactIndex);
  const baseContactName = identity.baseName;
  const contact = {
    name: contactNameFormats[contactIndex % contactNameFormats.length](baseContactName),
    emoji: '',
    color: avatarColors[contactIndex % avatarColors.length]
  };
  const avatarGender = identity.gender;
  const { message, emoji, chatTime, replyTime, statusTime } = phraseForScene(loss, region, summary, variantIndex, contactIndex, theme, avatarGender, ownerEmail);
  const batteryPercent = crypto.randomInt(10, 101);
  const stickerAsset = contactIndex;
  const replyOutcome = loss ? 'loss' : 'gain';
  const replyPool = avatarGender === 'female' ? femaleMentorReplies[replyOutcome] : dominicanReplies[replyOutcome];
  const baseReply = replyPool[(contactIndex + variantIndex) % replyPool.length];
  const replyEmoji = replyEmojis[loss ? 'loss' : 'gain'][contactIndex % replyEmojis[loss ? 'loss' : 'gain'].length];
  const personalizedReply = baseReply
    .replaceAll('{{nombre}}', contact.name.split(' ')[0])
    .replaceAll('{{emoji}}', replyEmoji);
  const reply = conversationText(baseReply.includes('{{emoji}}')
    ? personalizedReply
    : personalizedReply.replace(/([.!?])(?=\s|$)/, `$1 ${replyEmoji}`));
  const rowsText = loss ? sceneRows.map((row, index) => `Fila ${index + 1}: XAUUSD ${row.side} 0.0${row.lot}; ${row.entryText} → ${row.closeText}; resultado ${row.amountText}; ${date} ${row.time}.`).join(' ') : `Conserva la captura de referencia ${reference.file} con sus importes originales; recorta únicamente espacio blanco central para mostrarla dentro del chat sin deformarla.`;
  const layoutVariant = layoutIndex % 3;
  const attachmentCrop = ['full', 'lower-cut', 'viewport'][layoutVariant];
  const prompt = [
    `Composición local de chat con resultado ${loss ? 'negativo' : 'positivo'} y estilo regional ${region.label || 'latinoamericano'}.`,
    rowsText,
    `Mensaje recibido: ${message}`,
    `Respuesta del mentor: ${reply}`,
    `Resumen visible: beneficio ${summary.profitText}, swap ${summary.swapText}, balance ${summary.balanceText}.`
  ].join(' ');
  return {
    prompt,
    scene: {
      region, contact, connectionStatus: connectionStatuses[contactIndex % connectionStatuses.length], rows: sceneRows, summary, message, reply,
      messages: [{ role: 'received', text: message }, { role: 'sent', text: reply }],
      loss, date, chatTime, replyTime, statusTime, batteryPercent, stickerAsset, theme,
      showSticker: !loss && contactIndex % 2 === 0,
      wallpaperAsset: theme === 'night' ? contactIndex % 5 : 0,
      layoutVariant, attachmentCrop, avatarGender, avatarAsset: contactIndex % 50,
      referencePath: loss ? null : path.join(REFERENCE_DIR, theme === 'night' && reference.file !== '08-night.png' ? path.join('dark', reference.file) : reference.file),
      referenceTopHeight: reference.topHeight,
      referenceTopOffset: reference.file === '08-night.png' ? 100 : 0
    }
  };
}

function automaticTradePrompt(slot, today, advancePhrase = true, themeOverride = null, ownerEmail = ALEXANDER_EMAIL) {
  const theme = themeOverride || themeForAutomaticSlot(slot);
  const pool = theme === 'night' ? tradeReferences.length : tradeReferences.length - 1;
  const ownerOffset = [...ownerEmail].reduce((total, char) => total + char.charCodeAt(0), 0);
  const offset = ([...today].reduce((total, char) => total + char.charCodeAt(0), 0) + composeSequence + ownerOffset) % pool;
  const referenceIndex = (offset + slot) % pool;
  const regionIndex = (offset + slot) % regionalStyles.length;
  const loss = slot === 3 || slot === 7;
  const phraseIndex = nextPhraseIndex(loss, advancePhrase, ownerEmail);
  const ownerImageCount = db.prepare('SELECT COUNT(*) AS count FROM images WHERE owner_email = ?').get(ownerEmail).count;
  const contactIndex = ownerImageCount + ownerOffset;
  const layoutIndex = contactIndex + [...today].reduce((total, char) => total + char.charCodeAt(0), 0);
  return { referenceIndex, ...tradeBrief(tradeReferences[referenceIndex], regionalStyles[regionIndex], loss, phraseIndex, contactIndex, layoutIndex, theme, ownerEmail) };
}

const nextManualTheme = db.transaction(() => {
  const key = 'manual_theme_cursor';
  const cursor = Number(db.prepare('SELECT value FROM phrase_library_meta WHERE key = ?').get(key)?.value || 0);
  db.prepare('INSERT INTO phrase_library_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(cursor + 1));
  return themeForManualCursor(cursor);
});

function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function requireAuth(req, res, next) {
  if (!req.session.authenticated || !req.session.email) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  next();
}

function loginAccounts() {
  const sharedFallback = process.env.LOGIN_PASSWORD || '';
  return [
    { email: ALEXANDER_EMAIL, password: process.env.ALEXANDER_PASSWORD || sharedFallback },
    { email: JORGE_EMAIL, password: process.env.JORGE_PASSWORD || sharedFallback }
  ];
}

function hasLoginConfig() {
  const accounts = loginAccounts();
  return Boolean(accounts.every((account) => account.password) && process.env.SESSION_SECRET);
}

async function passwordMatches(password, expected) {
  if (!expected) return false;
  if (expected.startsWith('$2')) return bcrypt.compare(password, expected);
  return crypto.timingSafeEqual(
    Buffer.from(password.padEnd(256, '\0').slice(0, 256)),
    Buffer.from(expected.padEnd(256, '\0').slice(0, 256))
  );
}

app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: (req) => /^\/images\/[^/]+\/file$/.test(req.path)
}));
app.use('/api/login', rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false }));

app.get('/api/config', (_req, res) => {
  res.json({ configured: hasLoginConfig(), timezone: TIME_ZONE });
});

app.post('/api/login', async (req, res, next) => {
  try {
    if (!hasLoginConfig()) return res.status(503).json({ error: 'Faltan las contraseñas de las cuentas o SESSION_SECRET en .env.' });
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 256) {
      return res.status(400).json({ error: 'Correo o contraseña inválidos.' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    const account = loginAccounts().find((item) => item.email === normalizedEmail);
    if (!account || !await passwordMatches(password, account.password)) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.authenticated = true;
      req.session.email = account.email;
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        res.json({ ok: true, email: req.session.email });
      });
    });
  } catch (err) { next(err); }
});

app.post('/api/logout', requireAuth, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('chatstudio.sid', { httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE });
    res.json({ ok: true });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ email: req.session.email });
});

function usageToday(ownerEmail) {
  const today = dayKey();
  return db.prepare('SELECT COUNT(*) AS count FROM images WHERE owner_email = ? AND day_key = ?').get(ownerEmail, today).count;
}

function imagePayload(row) {
  return {
    id: row.id,
    name: row.display_name,
    prompt: row.prompt,
    createdAt: row.created_at,
    url: `/api/images/${row.id}/file`,
    downloadUrl: `/api/images/${row.id}/file?download=1`,
    downloaded: Boolean(row.downloaded_at),
    source: row.filename.includes('-original-') ? 'authentic' : row.filename.includes('-plantilla-') ? 'template' : 'ai'
  };
}

async function generateAndStoreTemplate({ scene, prompt }, ownerEmail, batchId = null) {
  const imageBuffer = await renderTelegramChat(scene);
  const id = crypto.randomUUID();
  const filename = `${dayKey()}-plantilla-${id.slice(0, 8)}.png`;
  const filePath = path.join(IMAGE_DIR, filename);
  fs.writeFileSync(filePath, imageBuffer, { flag: 'wx' });
  const createdAt = new Date().toISOString();
  try {
    db.prepare('INSERT INTO images (id, filename, display_name, prompt, created_at, day_key, mime_type, owner_email, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, filename, `${scene.contact.name} ${scene.contact.emoji}`, prompt, createdAt, dayKey(new Date(createdAt)), 'image/png', ownerEmail, batchId);
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    throw err;
  }
  return db.prepare('SELECT * FROM images WHERE id = ?').get(id);
}

let batchProcessorRunning = false;

function batchPayload(row) {
  return {
    id: row.id,
    kind: row.kind,
    quantity: row.quantity,
    completed: row.completed,
    failed: row.failed,
    status: row.status,
    error: row.error,
    dayKey: row.day_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createBatch(ownerEmail, quantity, kind = 'manual') {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO generation_batches
    (id, owner_email, day_key, kind, quantity, completed, failed, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, 'pending', ?, ?)`)
    .run(id, ownerEmail, dayKey(), kind, quantity, now, now);
  return db.prepare('SELECT * FROM generation_batches WHERE id = ?').get(id);
}

function ensureDailyBatches() {
  if (!hasLoginConfig()) return;
  const today = dayKey();
  for (const account of loginAccounts()) {
    const exists = db.prepare("SELECT id FROM generation_batches WHERE owner_email = ? AND day_key = ? AND kind = 'automatic'").get(account.email, today);
    if (!exists) {
      try { createBatch(account.email, 10, 'automatic'); }
      catch (error) {
        if (!String(error.message).includes('UNIQUE')) throw error;
      }
    }
  }
}

async function processGenerationBatches() {
  if (batchProcessorRunning) return;
  batchProcessorRunning = true;
  try {
    db.prepare("UPDATE generation_batches SET status = 'pending', updated_at = ? WHERE status = 'running'").run(new Date().toISOString());
    while (true) {
      const batch = db.prepare("SELECT * FROM generation_batches WHERE status = 'pending' ORDER BY CASE kind WHEN 'automatic' THEN 0 ELSE 1 END, created_at LIMIT 1").get();
      if (!batch) break;
      db.prepare("UPDATE generation_batches SET status = 'running', error = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), batch.id);
      let completed = db.prepare('SELECT COUNT(*) AS count FROM images WHERE batch_id = ?').get(batch.id).count;
      try {
        for (let index = completed; index < batch.quantity; index++) {
          const automatic = automaticTradePrompt(index % 10, batch.day_key, true, batch.kind === 'manual' ? nextManualTheme() : null, batch.owner_email);
          await generateAndStoreTemplate(automatic, batch.owner_email, batch.id);
          completed += 1;
          db.prepare("UPDATE generation_batches SET completed = ?, updated_at = ? WHERE id = ?").run(completed, new Date().toISOString(), batch.id);
        }
        db.prepare("UPDATE generation_batches SET status = 'completed', completed = quantity, updated_at = ? WHERE id = ?").run(new Date().toISOString(), batch.id);
      } catch (error) {
        db.prepare("UPDATE generation_batches SET status = 'failed', completed = ?, failed = quantity - ?, error = ?, updated_at = ? WHERE id = ?")
          .run(completed, completed, String(error.message || 'No se pudo completar la generación.').slice(0, 500), new Date().toISOString(), batch.id);
        console.error(`Batch ${batch.id} failed for ${batch.owner_email}:`, error.message);
      }
    }
  } finally {
    batchProcessorRunning = false;
  }
}

function wakeBatchProcessor() {
  setImmediate(() => { void processGenerationBatches(); });
}

function runDailyGenerator() {
  ensureDailyBatches();
  wakeBatchProcessor();
}

app.get('/api/images', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT images.*, generation_batches.kind AS batch_kind
    FROM images LEFT JOIN generation_batches ON generation_batches.id = images.batch_id
    WHERE images.owner_email = ? ORDER BY images.day_key DESC, images.created_at DESC LIMIT 500`).all(req.session.email);
  const grouped = [];
  for (const row of rows) {
    let group = grouped.at(-1);
    if (!group || group.dayKey !== row.day_key) {
      group = { dayKey: row.day_key, images: [], dailyPackIds: [] };
      grouped.push(group);
    }
    group.images.push(imagePayload(row));
    if (row.batch_kind === 'automatic' && group.dailyPackIds.length < 10) group.dailyPackIds.push(row.id);
  }
  for (const group of grouped) if (!group.dailyPackIds.length) group.dailyPackIds = group.images.slice(0, 10).map((image) => image.id);
  res.json({ groups: grouped, total: rows.length, today: usageToday(req.session.email), timezone: TIME_ZONE });
});

app.get('/api/images/day/:dayKey/download', requireAuth, (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.dayKey)) return res.status(400).json({ error: 'La fecha no es válida.' });
  let rows = db.prepare(`SELECT images.* FROM images
    JOIN generation_batches ON generation_batches.id = images.batch_id
    WHERE images.owner_email = ? AND images.day_key = ? AND generation_batches.kind = 'automatic'
    ORDER BY images.created_at ASC LIMIT 10`).all(req.session.email, req.params.dayKey);
  if (!rows.length) rows = db.prepare('SELECT * FROM images WHERE owner_email = ? AND day_key = ? ORDER BY created_at DESC LIMIT 10').all(req.session.email, req.params.dayKey);
  rows = rows.filter((row) => fs.existsSync(path.join(IMAGE_DIR, path.basename(row.filename))));
  if (!rows.length) return res.status(404).json({ error: 'No hay imágenes disponibles para ese día.' });

  const downloadedAt = new Date().toISOString();
  db.transaction(() => {
    const mark = db.prepare('UPDATE images SET downloaded_at = ? WHERE id = ? AND owner_email = ?');
    for (const row of rows) mark.run(downloadedAt, row.id, req.session.email);
  })();
  res.attachment(`testimonios-${req.params.dayKey}.zip`);
  const archive = new ZipArchive({ zlib: { level: 7 } });
  archive.on('error', (error) => { if (!res.headersSent) res.status(500).json({ error: 'No se pudo preparar el paquete.' }); else res.destroy(error); });
  archive.pipe(res);
  rows.forEach((row, index) => archive.file(path.join(IMAGE_DIR, path.basename(row.filename)), { name: `${String(index + 1).padStart(2, '0')}-${row.filename}` }));
  void archive.finalize();
});

app.delete('/api/images', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))] : [];
  if (!ids.length || ids.length > 500 || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
    return res.status(400).json({ error: 'Selecciona entre 1 y 500 imágenes válidas.' });
  }
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, filename FROM images WHERE owner_email = ? AND id IN (${placeholders})`).all(req.session.email, ...ids);
  if (!rows.length) return res.status(404).json({ error: 'No encontramos imágenes tuyas con esa selección.' });
  db.transaction(() => {
    db.prepare(`DELETE FROM images WHERE owner_email = ? AND id IN (${placeholders})`).run(req.session.email, ...rows.map((row) => row.id));
  })();
  for (const row of rows) fs.rmSync(path.join(IMAGE_DIR, path.basename(row.filename)), { force: true });
  res.json({ deleted: rows.length });
});

function parsePhrase(req, res) {
  const outcome = req.body?.outcome;
  const body = typeof req.body?.body === 'string' ? req.body.body.trim().replace(/\s+/g, ' ') : '';
  if (!['gain', 'loss'].includes(outcome) || body.length < 20 || body.length > 260) {
    res.status(400).json({ error: 'Elige ganancia o pérdida y escribe una frase de 20 a 260 caracteres.' });
    return null;
  }
  const placeholders = body.match(/{{[^}]+}}/g) || [];
  if (placeholders.some((item) => !['{{saludo}}', '{{tratamiento}}', '{{profit}}', '{{cierre}}', '{{emoji}}'].includes(item))) {
    res.status(400).json({ error: 'Usa solo {{saludo}}, {{tratamiento}}, {{profit}}, {{cierre}} y {{emoji}}.' });
    return null;
  }
  const withoutVariants = body.replace(/\[\[([^\[\]]+)\]\]/g, (_match, choices) => choices.split('|').length >= 2 ? '' : '__invalid__');
  if (withoutVariants.includes('[[') || withoutVariants.includes(']]') || withoutVariants.includes('__invalid__')) {
    res.status(400).json({ error: 'Para variar texto, escribe al menos dos opciones: [[opción A|opción B]].' });
    return null;
  }
  return { outcome, body };
}

app.get('/api/phrases', requireAuth, (req, res) => {
  res.json({ phrases: db.prepare('SELECT id, outcome, body, created_at AS createdAt FROM phrase_templates WHERE owner_email = ? ORDER BY id').all(req.session.email) });
});

app.post('/api/phrases', requireAuth, (req, res) => {
  const phrase = parsePhrase(req, res);
  if (!phrase) return;
  const count = db.prepare('SELECT COUNT(*) AS count FROM phrase_templates WHERE owner_email = ?').get(req.session.email).count;
  if (count >= 100) return res.status(400).json({ error: 'El banco admite hasta 100 frases.' });
  const createdAt = new Date().toISOString();
  const result = db.prepare('INSERT INTO phrase_templates (outcome, body, created_at, owner_email) VALUES (?, ?, ?, ?)').run(phrase.outcome, phrase.body, createdAt, req.session.email);
  res.status(201).json({ phrase: { id: result.lastInsertRowid, ...phrase, createdAt } });
});

app.delete('/api/phrases/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM phrase_templates WHERE id = ? AND owner_email = ?').run(req.params.id, req.session.email);
  if (!result.changes) return res.status(404).json({ error: 'No encontramos esa frase.' });
  res.json({ ok: true });
});

app.post('/api/generation-jobs', requireAuth, (req, res) => {
  const quantity = Number(req.body?.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    return res.status(400).json({ error: 'Selecciona una cantidad entre 1 y 50.' });
  }
  const batch = createBatch(req.session.email, quantity, 'manual');
  wakeBatchProcessor();
  res.status(202).json({ job: batchPayload(batch) });
});

app.get('/api/generation-jobs', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM generation_batches WHERE owner_email = ? ORDER BY created_at DESC LIMIT 30').all(req.session.email);
  res.json({ jobs: rows.map(batchPayload) });
});

app.get('/api/generation-jobs/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM generation_batches WHERE id = ? AND owner_email = ?').get(req.params.id, req.session.email);
  if (!row) return res.status(404).json({ error: 'No encontramos esa generación.' });
  res.json({ job: batchPayload(row) });
});

// The panel only supports the configured batch compositor.
for (const retiredPath of ['/api/generate', '/api/preview-template', '/api/generate-template', '/api/import-authentic']) {
  app.all(retiredPath, requireAuth, (_req, res) => res.status(410).json({ error: 'Esta opción ya no está disponible.' }));
}

app.get('/api/images/:id/file', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM images WHERE id = ? AND owner_email = ?').get(req.params.id, req.session.email);
  if (!row) return res.status(404).json({ error: 'No encontramos esa imagen.' });
  const safePath = path.join(IMAGE_DIR, path.basename(row.filename));
  if (!fs.existsSync(safePath)) return res.status(404).json({ error: 'El archivo de imagen ya no está disponible.' });
  if (req.query.download === '1') {
    db.prepare('UPDATE images SET downloaded_at = ? WHERE id = ? AND owner_email = ?').run(new Date().toISOString(), row.id, req.session.email);
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
  }
  res.type(row.mime_type).sendFile(safePath);
});

app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('*splat', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Ocurrió un error inesperado. Intenta de nuevo.' });
});

app.listen(PORT, () => {
  console.log(`TESTIMONIOS TELEGRAM listo en http://localhost:${PORT}`);
  if (!hasLoginConfig()) console.warn('Configura ALEXANDER_PASSWORD, JORGE_PASSWORD y SESSION_SECRET antes de iniciar sesión.');
  if (process.env.SESSION_SECRET === 'development-only-change-this-secret') console.warn('SESSION_SECRET tiene el valor de desarrollo; reemplázalo antes de exponer el servidor.');
  const schedulerTimer = setInterval(() => { void runDailyGenerator(); }, 60_000);
  schedulerTimer.unref();
  void runDailyGenerator();
});
