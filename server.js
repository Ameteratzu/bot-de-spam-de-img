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
import { rateLimit } from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { renderTelegramChat, conversationText } from './telegram-compositor.js';
import { themeForAutomaticSlot, themeForManualCursor } from './scene-theme.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const TIME_ZONE = process.env.APP_TIMEZONE || 'America/Lima';
const COOKIE_SECURE = process.env.COOKIE_SECURE === undefined
  ? process.env.NODE_ENV === 'production'
  : process.env.COOKIE_SECURE === 'true';
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-lite-image';
const AUTOMATIC_RENDER_MODE = 'template';
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

const defaultPhrases = [
  ['gain', '{{saludo}}, {{tratamiento}}. Cerré el día en positivo {{emoji}} con {{profit}}. Gracias por tus consejos; me ayudaron a seguir el plan.'],
  ['gain', 'Amigo querido, muchas bendiciones. Hoy terminé con {{profit}} {{emoji}} y estoy contento con el avance de la IA. Gracias por acompañarme.'],
  ['gain', '{{saludo}}, [[líder|bro]]. Las operaciones cerraron con {{profit}} {{emoji}}. Gracias por ayudarme a tener paciencia y cuidar cada entrada.'],
  ['gain', '{{saludo}}, {{tratamiento}}. Me alegró cerrar con {{profit}} {{emoji}}. Gracias por tu tiempo y por acompañarme en el proceso.'],
  ['loss', '{{saludo}}, {{tratamiento}}. Hoy cerré con {{profit}} {{emoji}}. Me toca revisar las entradas; gracias por ayudarme a volver al plan.'],
  ['loss', '{{saludo}}, líder. La sesión terminó en {{profit}} {{emoji}}. Gracias por ayudarme a revisar el riesgo y ver qué puedo mejorar.']
];
const guidancePhrases = [
  '{{saludo}}, líder. Estoy encantado de trabajar con usted y aprender a usar la herramienta. Al principio tenía mis dudas, pero me animé a probarla y hoy cerré con {{profit}}. Gracias por guiarme {{emoji}}.',
  '{{saludo}}, {{tratamiento}}. Estoy demasiado emocionado: hoy cerré con {{profit}}. Lo mejor es compartir este proceso con una comunidad que me ayuda a aprender. ¡Vamos por más, líder! {{emoji}}',
  'Hola, hermano. Comencé con muchas dudas y mira cómo voy avanzando: {{profit}} en esta sesión. Gracias por la herramienta y por estar pendiente; quiero seguir aprendiendo a manejar mejor el riesgo.',
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
  [defaultPhrases[5][1], '{{saludo}}, líder. Esta sesión simulada terminó en {{profit}}. Gracias por acompañarme a entender el error; aprendí más revisando el riesgo que mirando solo el resultado.']
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

function nextPhraseIndex(loss, advance = true) {
  return db.transaction(() => {
    const outcome = loss ? 'loss' : 'gain';
    const key = `phrase_cursor_${outcome}`;
    const saved = db.prepare('SELECT value FROM phrase_library_meta WHERE key = ?').get(key);
    const count = db.prepare('SELECT COUNT(*) AS count FROM phrase_templates WHERE outcome = ?').get(outcome).count;
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
  [defaultPhrases[5][1], '{{saludo}}, líder. La sesión terminó en {{profit}} {{emoji}}. Gracias por ayudarme a revisar el riesgo y ver qué puedo mejorar.']
].forEach(([updated, previous]) => compactPhraseUpgrade.run(updated, previous));
// Migrate the exact built-in templates saved by earlier releases to the
// contextual emoji placeholder; user-edited phrase bodies remain untouched.
[
  [defaultPhrases[0][1], '{{saludo}}, {{tratamiento}}. Cerré el día en positivo con {{profit}}. Gracias por tus consejos; me ayudaron a seguir el plan 🤖.'],
  [defaultPhrases[1][1], 'Amigo querido, muchas bendiciones. Hoy terminé con {{profit}} y estoy contento con el avance de la IA 🤖. Gracias por acompañarme.'],
  [defaultPhrases[2][1], '{{saludo}}, [[líder|bro]]. Las operaciones cerraron con {{profit}}. Gracias por ayudarme a tener paciencia y cuidar cada entrada.'],
  [defaultPhrases[3][1], '{{saludo}}, {{tratamiento}}. Me alegró cerrar con {{profit}}. Gracias por tu tiempo y por acompañarme en el proceso.'],
  [defaultPhrases[4][1], '{{saludo}}, {{tratamiento}}. Hoy cerré con {{profit}}. Me toca revisar las entradas; gracias por ayudarme a volver al plan.'],
  [defaultPhrases[5][1], '{{saludo}}, líder. La sesión terminó en {{profit}}. Gracias por ayudarme a revisar el riesgo y ver qué puedo mejorar.']
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
const chatContacts = [
  'Mateo Rojas', 'Camila Torres', 'Andrés Mejía', 'Sofía Paredes', 'Daniel Vargas',
  'Lucía Herrera', 'Nicolás Muñoz', 'Valentina Cruz', 'Joaquín Salazar', 'Mariana Soto',
  'Gabriel Molina', 'Renata Castillo', 'Emilio Núñez', 'Isabella Reyes'
];
const femaleContactNames = new Set(['Camila', 'Sofía', 'Lucía', 'Valentina', 'Mariana', 'Renata', 'Isabella']);
const connectionStatuses = [
  'en línea',
  'últ. vez hace 3 minutos',
  'últ. vez hace 9 minutos',
  'últ. vez hace 18 minutos',
  'últ. vez hace 1 hora',
  'últ. vez recientemente'
];
const chatEmojis = ['🤖', '🤩', '🤑', '🥳', '🤪', '🤯', '🤓', '😳', '🥸'];
const contextEmojis = {
  gain: ['🤩', '🤑', '🥳', '🤪', '🤯', '🤓', '🤖'],
  loss: ['😳', '🤓', '🥸', '🤖', '🤯', '😠']
};
const replyEmojis = {
  gain: ['🎉', '🏆', '🚀', '🙌', '💪', '🔥'],
  loss: ['🧠', '💡', '📝', '🙏']
};
const avatarColors = ['#456c93', '#8062a8', '#ad725e', '#4c8279', '#ac6e89', '#546d9d', '#9d7c49', '#6b8198', '#8974ad', '#63855d'];
const composeSequence = db.prepare('SELECT COUNT(*) AS count FROM images').get().count;
const regionalStyles = [
  { label: 'Perú 🇵🇪', slang: 'causa', reply: '¡Qué alegría, líder! Felicitaciones por seguir el plan; sigamos con constancia.' },
  { label: 'México 🇲🇽', slang: 'qué onda', reply: '¡Eso, bro! Felicidades por la disciplina; vamos paso a paso y cuidando el riesgo.' },
  { label: 'Colombia 🇨🇴', slang: 'parce', reply: '¡Eso, parce! Qué gusto ver tu disciplina. Felicitaciones, seguimos firmes.' },
  { label: 'Argentina 🇦🇷', slang: 'che', reply: '¡Bien ahí, che! Felicitaciones por sostener el plan. Seguimos atentos al riesgo.' },
  { label: 'Chile 🇨🇱', slang: 'bacán', reply: '¡Buena, compa! Felicitaciones por la constancia; sigamos cuidando cada entrada.' },
  { label: 'Ecuador 🇪🇨', slang: 'ñaño', reply: '¡Qué gusto, ñaño! Felicitaciones por la disciplina. Sigamos con calma.' },
  { label: 'Venezuela 🇻🇪', slang: 'pana', reply: '¡Eso, pana! Felicitaciones por seguir el plan; vamos con calma y buen manejo del riesgo.' }
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

function phraseForScene(loss, region, summary, variantIndex, contactIndex = 0, theme = 'day', avatarGender = 'male') {
  const outcome = loss ? 'loss' : 'gain';
  const emoji = contextEmojis[outcome][contactIndex % contextEmojis[outcome].length];
  const options = db.prepare('SELECT id, body FROM phrase_templates WHERE outcome = ? ORDER BY id').all(outcome);
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

function tradeBrief(reference, region, loss = false, variantIndex = 0, contactIndex = 0, layoutIndex = 0, theme = 'day') {
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
  const contact = {
    name: chatContacts[contactIndex % chatContacts.length],
    emoji: chatEmojis[contactIndex % chatEmojis.length],
    color: avatarColors[contactIndex % avatarColors.length]
  };
  const avatarGender = femaleContactNames.has(contact.name.split(' ')[0]) ? 'female' : 'male';
  const { message, emoji, chatTime, replyTime, statusTime } = phraseForScene(loss, region, summary, variantIndex, contactIndex, theme, avatarGender);
  contact.emoji = emoji || contact.emoji;
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

function automaticTradePrompt(slot, today, advancePhrase = true, themeOverride = null) {
  const theme = themeOverride || themeForAutomaticSlot(slot);
  const pool = theme === 'night' ? tradeReferences.length : tradeReferences.length - 1;
  const offset = ([...today].reduce((total, char) => total + char.charCodeAt(0), 0) + composeSequence) % pool;
  const referenceIndex = (offset + slot) % pool;
  const regionIndex = (offset + slot) % regionalStyles.length;
  const loss = slot === 3 || slot === 7;
  const phraseIndex = nextPhraseIndex(loss, advancePhrase);
  const contactIndex = db.prepare('SELECT COUNT(*) AS count FROM images').get().count;
  const layoutIndex = contactIndex + [...today].reduce((total, char) => total + char.charCodeAt(0), 0);
  return { referenceIndex, ...tradeBrief(tradeReferences[referenceIndex], regionalStyles[regionIndex], loss, phraseIndex, contactIndex, layoutIndex, theme) };
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

function localMinuteOfDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return get('hour') * 60 + get('minute');
}

function requireAuth(req, res, next) {
  if (!req.session.authenticated) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  next();
}

function hasLoginConfig() {
  return Boolean(process.env.LOGIN_EMAIL && process.env.LOGIN_PASSWORD && process.env.SESSION_SECRET);
}

app.use('/api', rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api/login', rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false }));

app.get('/api/config', (_req, res) => {
  res.json({ configured: hasLoginConfig(), timezone: TIME_ZONE, automaticRenderMode: AUTOMATIC_RENDER_MODE, manualImageModel: MODEL });
});

app.post('/api/login', async (req, res, next) => {
  try {
    if (!hasLoginConfig()) return res.status(503).json({ error: 'Faltan LOGIN_EMAIL, LOGIN_PASSWORD o SESSION_SECRET en .env.' });
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 256) {
      return res.status(400).json({ error: 'Correo o contraseña inválidos.' });
    }
    const emailMatches = crypto.timingSafeEqual(
      Buffer.from(email.trim().toLowerCase().padEnd(254, '\0').slice(0, 254)),
      Buffer.from(process.env.LOGIN_EMAIL.trim().toLowerCase().padEnd(254, '\0').slice(0, 254))
    );
    const passwordMatches = process.env.LOGIN_PASSWORD.startsWith('$2')
      ? await bcrypt.compare(password, process.env.LOGIN_PASSWORD)
      : crypto.timingSafeEqual(
          Buffer.from(password.padEnd(256, '\0').slice(0, 256)),
          Buffer.from(process.env.LOGIN_PASSWORD.padEnd(256, '\0').slice(0, 256))
        );
    if (!emailMatches || !passwordMatches) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.authenticated = true;
      req.session.email = process.env.LOGIN_EMAIL.trim().toLowerCase();
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
    res.clearCookie('chatstudio.sid', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
    res.json({ ok: true });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ email: req.session.email });
});

function usageToday() {
  const today = dayKey();
  return db.prepare('SELECT COUNT(*) AS count FROM images WHERE day_key = ?').get(today).count;
}

function imagePayload(row) {
  return {
    id: row.id,
    name: row.display_name,
    prompt: row.prompt,
    createdAt: row.created_at,
    url: `/api/images/${row.id}/file`,
    downloadUrl: `/api/images/${row.id}/file?download=1`,
    source: row.filename.includes('-original-') ? 'authentic' : row.filename.includes('-plantilla-') ? 'template' : 'ai'
  };
}

async function generateAndStoreImage(userPrompt, referenceIndex = null) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const generationInstruction = `Create one polished 9:16 fictional mobile chat image based on this creative brief. Keep text in natural Spanish. Fictional financial results and testimonials must be clearly marked within the image; never present them as verified evidence. Brief: ${userPrompt}`;
  const input = referenceIndex === null ? generationInstruction : [
    { type: 'text', text: `${generationInstruction} Follow the brief: preserve source trade values when requested, or use the specified fictional values. Keep the visible generated-content disclosure.` },
    { type: 'image', data: fs.readFileSync(path.join(REFERENCE_DIR, tradeReferences[referenceIndex].file)).toString('base64'), mime_type: 'image/png' }
  ];
  const interaction = await ai.interactions.create({
    model: MODEL,
    input,
    response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '9:16', image_size: '1K' }
  });
  const imageData = interaction.output_image?.data;
  if (!imageData) throw new Error('Gemini respondió sin una imagen.');
  const imageBuffer = Buffer.from(imageData, 'base64');
  if (imageBuffer.length > 15 * 1024 * 1024) throw new Error('La imagen recibida excede el tamaño permitido.');
  const id = crypto.randomUUID();
  const randomName = pick(names);
  const emoji = pick(emojis);
  const displayName = `${randomName}${emoji ? ` ${emoji}` : ''}`;
  const filename = `${dayKey()}-${randomName.toLowerCase()}-${id.slice(0, 8)}.jpg`;
  const filePath = path.join(IMAGE_DIR, filename);
  fs.writeFileSync(filePath, imageBuffer, { flag: 'wx' });
  const createdAt = new Date().toISOString();
  try {
    db.prepare('INSERT INTO images (id, filename, display_name, prompt, created_at, day_key, mime_type) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, filename, displayName, userPrompt, createdAt, dayKey(new Date(createdAt)), 'image/jpeg');
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    throw err;
  }
  return db.prepare('SELECT * FROM images WHERE id = ?').get(id);
}

async function generateAndStoreTemplate({ scene, prompt }) {
  const imageBuffer = await renderTelegramChat(scene);
  const id = crypto.randomUUID();
  const filename = `${dayKey()}-plantilla-${id.slice(0, 8)}.png`;
  const filePath = path.join(IMAGE_DIR, filename);
  fs.writeFileSync(filePath, imageBuffer, { flag: 'wx' });
  const createdAt = new Date().toISOString();
  try {
    db.prepare('INSERT INTO images (id, filename, display_name, prompt, created_at, day_key, mime_type) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, filename, `${scene.contact.name} ${scene.contact.emoji}`, prompt, createdAt, dayKey(new Date(createdAt)), 'image/png');
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    throw err;
  }
  return db.prepare('SELECT * FROM images WHERE id = ?').get(id);
}

let schedulerRunning = false;
const jobInsert = db.prepare('INSERT OR IGNORE INTO daily_generation_jobs (day_key, slot, prompt, status, updated_at) VALUES (?, ?, ?, \'pending\', ?)');
const jobUpdate = db.prepare('UPDATE daily_generation_jobs SET status = ?, attempts = ?, image_id = ?, error = ?, updated_at = ? WHERE day_key = ? AND slot = ?');

async function runDailyGenerator() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const today = dayKey();
    const currentMinute = localMinuteOfDay();
    const latestDueSlot = Math.min(9, Math.floor(currentMinute / 144));
    const insertDueJobs = db.transaction(() => {
      for (let slot = 0; slot <= latestDueSlot; slot++) {
        jobInsert.run(today, slot, automaticTradePrompt(slot, today, false).prompt, new Date().toISOString());
      }
    });
    insertDueJobs();

    while (true) {
      const now = Date.now();
      const job = db.prepare(`SELECT * FROM daily_generation_jobs
        WHERE day_key = ? AND (status = 'pending' OR (status = 'failed' AND attempts < 3 AND updated_at <= ?))
        ORDER BY slot LIMIT 1`).get(today, new Date(now - 15 * 60_000).toISOString());
      if (!job) break;
      const attempts = job.attempts + 1;
      jobUpdate.run('running', attempts, null, null, new Date().toISOString(), today, job.slot);
      try {
        const automatic = automaticTradePrompt(job.slot, today);
        const image = await generateAndStoreTemplate(automatic);
        jobUpdate.run('completed', attempts, image.id, null, new Date().toISOString(), today, job.slot);
        console.log(`Automatic image ${job.slot + 1}/10 generated for ${today}.`);
      } catch (error) {
        jobUpdate.run('failed', attempts, null, String(error.message || 'Generation failed').slice(0, 500), new Date().toISOString(), today, job.slot);
        console.error(`Automatic image ${job.slot + 1}/10 failed (attempt ${attempts}/3):`, error.message);
        break;
      }
    }
  } finally {
    schedulerRunning = false;
  }
}

app.get('/api/images', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM images ORDER BY created_at DESC LIMIT 120').all();
  res.json({ images: rows.map(imagePayload), today: usageToday(), timezone: TIME_ZONE });
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

app.get('/api/phrases', requireAuth, (_req, res) => {
  res.json({ phrases: db.prepare('SELECT id, outcome, body, created_at AS createdAt FROM phrase_templates ORDER BY id').all() });
});

app.post('/api/phrases', requireAuth, (req, res) => {
  const phrase = parsePhrase(req, res);
  if (!phrase) return;
  const count = db.prepare('SELECT COUNT(*) AS count FROM phrase_templates').get().count;
  if (count >= 100) return res.status(400).json({ error: 'El banco admite hasta 100 frases.' });
  const createdAt = new Date().toISOString();
  const result = db.prepare('INSERT INTO phrase_templates (outcome, body, created_at) VALUES (?, ?, ?)').run(phrase.outcome, phrase.body, createdAt);
  res.status(201).json({ phrase: { id: result.lastInsertRowid, ...phrase, createdAt } });
});

app.put('/api/phrases/:id', requireAuth, (req, res) => {
  const phrase = parsePhrase(req, res);
  if (!phrase) return;
  const result = db.prepare('UPDATE phrase_templates SET outcome = ?, body = ? WHERE id = ?').run(phrase.outcome, phrase.body, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'No encontramos esa frase.' });
  res.json({ phrase: { id: Number(req.params.id), ...phrase } });
});

app.delete('/api/phrases/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM phrase_templates WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'No encontramos esa frase.' });
  res.json({ ok: true });
});

app.post('/api/generate', requireAuth, async (req, res, next) => {
  try {
    const userPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (userPrompt.length < 8 || userPrompt.length > 1500) return res.status(400).json({ error: 'Describe la imagen con entre 8 y 1500 caracteres.' });

    const usesTradingReference = /\b(?:xauusd|trading|trade|operaci[oó]n(?:es)?|historial|ganancias?|p[eé]rdidas?)\b/i.test(userPrompt);
    const gainSlots = [0, 1, 2, 4, 5, 6, 8, 9];
    const automatic = usesTradingReference ? automaticTradePrompt(gainSlots[db.prepare('SELECT COUNT(*) AS count FROM images').get().count % gainSlots.length], dayKey(), true, nextManualTheme()) : null;
    if (automatic) {
      const row = await generateAndStoreTemplate(automatic);
      return res.status(201).json({ image: imagePayload(row), today: usageToday() });
    }
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'Configura GEMINI_API_KEY en el archivo .env.' });
    const prompt = automatic ? `${automatic.prompt} Instrucción adicional: ${userPrompt}` : userPrompt;
    const row = await generateAndStoreImage(prompt, automatic?.referenceIndex ?? null);
    res.status(201).json({ image: imagePayload(row), today: usageToday() });
  } catch (err) {
    if (err?.status || err?.statusCode) {
      console.error('Gemini generation error:', err.message);
      return res.status(err.status || err.statusCode).json({ error: 'No se pudo generar la imagen. Revisa tu clave, cuota y configuración de Gemini.' });
    }
    next(err);
  }
});

function previewRow(token) {
  const row = db.prepare('SELECT * FROM template_previews WHERE token = ?').get(token);
  return row && Date.now() - Date.parse(row.created_at) < 3600000 ? row : null;
}

function addressMessage(message, preferredAddress, previousAddress = '') {
  const replacement = preferredAddress.trim();
  if (!replacement) return message;
  const escapedPrevious = previousAddress.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const choices = [escapedPrevious, 'jefe', 'líder', 'máster', 'causa', 'parce', 'pana', 'ñaño', 'che', 'compa', 'bro'].filter(Boolean);
  const vocative = new RegExp(`(?<![\\p{L}\\p{M}])(?:${choices.join('|')})(?![\\p{L}\\p{M}])`, 'iu');
  if (vocative.test(message)) return message.replace(vocative, replacement);
  return `${replacement}, ${message.charAt(0).toLowerCase()}${message.slice(1)}`;
}

app.post('/api/preview-template', requireAuth, async (req, res, next) => {
  try {
    const previous = req.body?.previewToken ? previewRow(String(req.body.previewToken)) : null;
    if (req.body?.previewToken && !previous) return res.status(404).json({ error: 'La vista previa caducó. Crea una nueva.' });
    const outcome = req.body?.outcome === 'loss' ? 'loss' : 'gain';
    const count = db.prepare('SELECT COUNT(*) AS count FROM images').get().count;
    const slots = outcome === 'gain' ? [0, 1, 2, 4, 5, 6, 8, 9] : [3, 7];
    const automatic = previous ? { scene: JSON.parse(previous.scene_json), prompt: previous.prompt } : automaticTradePrompt(slots[count % slots.length], dayKey(), true, nextManualTheme());
    const scene = automatic.scene;
    const variant = req.body?.layoutVariant === undefined ? scene.layoutVariant : Number(req.body.layoutVariant);
    if (!Number.isInteger(variant) || variant < 0 || variant > 2) return res.status(400).json({ error: 'Selecciona una escena válida.' });
    for (const [key, limit] of [['message', 700], ['reply', 350]]) {
      if (req.body?.[key] !== undefined) {
        const value = String(req.body[key]).trim();
        if (!value || value.length > limit) return res.status(400).json({ error: `El texto de ${key} debe tener entre 1 y ${limit} caracteres.` });
        scene[key] = conversationText(value);
      }
    }
    if (req.body?.preferredAddress !== undefined) {
      const preferredAddress = String(req.body.preferredAddress).trim();
      if (preferredAddress.length > 50 || (preferredAddress && !/^[\p{L}\p{M} .'-]+$/u.test(preferredAddress))) {
        return res.status(400).json({ error: 'Escribe un nombre o tratamiento de hasta 50 caracteres.' });
      }
      if (preferredAddress) scene.message = conversationText(addressMessage(scene.message, preferredAddress, scene.preferredAddress));
      scene.preferredAddress = preferredAddress;
    }
    scene.layoutVariant = variant;
    scene.attachmentCrop = ['full', 'lower-cut', 'full'][variant];
    scene.messages = [{ role: 'received', text: scene.message }, { role: 'sent', text: scene.reply }];
    const token = previous?.token || crypto.randomUUID();
    db.prepare('INSERT OR REPLACE INTO template_previews (token, scene_json, prompt, created_at) VALUES (?, ?, ?, ?)')
      .run(token, JSON.stringify(scene), automatic.prompt, new Date().toISOString());
    res.json({ previewToken: token, previewUrl: `/api/preview-template/${token}/file`, layoutVariant: variant, message: scene.message, reply: scene.reply, preferredAddress: scene.preferredAddress || '' });
  } catch (err) { next(err); }
});

app.get('/api/preview-template/:token/file', requireAuth, async (req, res, next) => {
  try {
    const row = previewRow(req.params.token);
    if (!row) return res.status(404).json({ error: 'La vista previa caducó.' });
    res.set('Cache-Control', 'no-store').type('png').send(await renderTelegramChat(JSON.parse(row.scene_json)));
  } catch (err) { next(err); }
});

app.post('/api/generate-template', requireAuth, async (req, res, next) => {
  try {
    const preview = req.body?.previewToken ? previewRow(String(req.body.previewToken)) : null;
    if (req.body?.previewToken && !preview) return res.status(404).json({ error: 'La vista previa caducó. Crea una nueva.' });
    if (preview) {
      const row = await generateAndStoreTemplate({ scene: JSON.parse(preview.scene_json), prompt: preview.prompt });
      db.prepare('DELETE FROM template_previews WHERE token = ?').run(preview.token);
      return res.status(201).json({ image: imagePayload(row), today: usageToday() });
    }
    const outcome = req.body?.outcome === 'loss' ? 'loss' : 'gain';
    const count = db.prepare('SELECT COUNT(*) AS count FROM images').get().count;
    const slots = outcome === 'gain' ? [0, 1, 2, 4, 5, 6, 8, 9] : [3, 7];
    const slot = slots[count % slots.length];
    const automatic = automaticTradePrompt(slot, dayKey(), true, nextManualTheme());
    const row = await generateAndStoreTemplate(automatic);
    res.status(201).json({ image: imagePayload(row), today: usageToday() });
  } catch (err) { next(err); }
});

// Imports a complete original chat screenshot byte-for-byte; no invented text or trade values.
app.post('/api/import-authentic', requireAuth, express.raw({ type: ['image/png', 'image/jpeg'], limit: '15mb' }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Selecciona una captura PNG o JPEG.' });
    let info;
    try { info = await sharp(req.body).metadata(); }
    catch { return res.status(400).json({ error: 'El archivo no es una imagen PNG o JPEG válida.' }); }
    if (!['png', 'jpeg'].includes(info.format) || info.width < 300 || info.height < 500 || info.width > 4000 || info.height > 8000) {
      return res.status(400).json({ error: 'La captura debe ser PNG o JPEG vertical, de tamaño válido.' });
    }
    const id = crypto.randomUUID();
    const extension = info.format === 'png' ? 'png' : 'jpg';
    const filename = `${dayKey()}-original-${id.slice(0, 8)}.${extension}`;
    const filePath = path.join(IMAGE_DIR, filename);
    fs.writeFileSync(filePath, req.body, { flag: 'wx' });
    const createdAt = new Date().toISOString();
    try {
      db.prepare('INSERT INTO images (id, filename, display_name, prompt, created_at, day_key, mime_type) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, filename, 'Captura original', 'Captura original aportada por el usuario, sin edición.', createdAt, dayKey(new Date(createdAt)), `image/${info.format}`);
    } catch (error) { fs.rmSync(filePath, { force: true }); throw error; }
    res.status(201).json({ image: imagePayload(db.prepare('SELECT * FROM images WHERE id = ?').get(id)), today: usageToday() });
  } catch (error) { next(error); }
});

app.get('/api/images/:id/file', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No encontramos esa imagen.' });
  const safePath = path.join(IMAGE_DIR, path.basename(row.filename));
  if (!fs.existsSync(safePath)) return res.status(404).json({ error: 'El archivo de imagen ya no está disponible.' });
  if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
  res.type(row.mime_type).sendFile(safePath);
});

app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('*splat', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Ocurrió un error inesperado. Intenta de nuevo.' });
});

app.listen(PORT, () => {
  console.log(`Chat Image Studio listo en http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) console.warn('GEMINI_API_KEY no está configurada; el login funciona, pero generar está deshabilitado.');
  if (!hasLoginConfig()) console.warn('Configura LOGIN_EMAIL, LOGIN_PASSWORD y SESSION_SECRET antes de iniciar sesión.');
  if (process.env.SESSION_SECRET === 'development-only-change-this-secret') console.warn('SESSION_SECRET tiene el valor de desarrollo; reemplázalo antes de exponer el servidor.');
  if (process.env.GEMINI_API_KEY && /AIza/.test(process.env.GEMINI_API_KEY)) {
    console.warn('Verifica en AI Studio que la clave está restringida y es una clave de autorización compatible con las políticas actuales de Gemini API.');
  }
  const schedulerTimer = setInterval(() => { void runDailyGenerator(); }, 60_000);
  schedulerTimer.unref();
  void runDailyGenerator();
});
