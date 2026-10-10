import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import * as fontkit from 'fontkit';
import { tradeImage } from './chat-compositor.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FONT_PATH = path.join(ROOT, 'assets', 'fonts', 'Inter.ttf');
const FONT = fontkit.openSync(FONT_PATH);
const FONT_DATA = fs.readFileSync(FONT_PATH).toString('base64');
const WALLPAPER_PATH = path.join(ROOT, 'assets', 'wallpapers', 'chat-green-doodle.jpg');
const WALLPAPER_DATA = fs.readFileSync(WALLPAPER_PATH).toString('base64');
const EMOJI_DIR = path.join(ROOT, 'assets', 'emoji', 'twemoji');
const TELEMOJI_DIR = path.join(ROOT, 'assets', 'emoji', 'telemoji');
function emojiAsset(code) {
  const telemojiPath = path.join(TELEMOJI_DIR, `${code}.png`);
  const fallbackPath = path.join(EMOJI_DIR, `${code}.png`);
  const assetPath = fs.existsSync(telemojiPath) ? telemojiPath : fallbackPath;
  return fs.existsSync(assetPath) ? fs.readFileSync(assetPath).toString('base64') : null;
}
const EMOJI_ASSET_BY_GLYPH = new Map([
  ['🤖', '1f916'], ['📈', '1f4c8'], ['🚀', '1f680'], ['💰', '1f4b0'], ['🎉', '1f389'],
  ['🙌', '1f64c'], ['💪', '1f4aa'], ['🏆', '1f3c6'], ['🔥', '1f525'], ['💵', '1f4b5'],
  ['📉', '1f4c9'], ['🧠', '1f9e0'], ['📝', '1f4dd'], ['💡', '1f4a1'], ['🙏', '1f64f'],
  ['✨', '2728'], ['🌟', '1f31f'], ['🎯', '1f3af'], ['💸', '1f4b8'], ['💹', '1f4b9'], ['👏', '1f44f'],
  ['😠', '1f620'], ['🤪', '1f92a'], ['🤯', '1f92f'], ['🥸', '1f978'], ['🤓', '1f913'],
  ['🤩', '1f929'], ['🤑', '1f911'], ['😈', '1f608'], ['🥳', '1f973'], ['😳', '1f633']
].map(([glyph, code]) => [glyph, emojiAsset(code)]));
const TELEGRAM_ICON_DIR = path.join(ROOT, 'assets', 'icons', 'telegram');
const iconCache = new Map();
const W = 900;
const H = 1600;
const CHAT_TOP = 165;
const COMPOSER_TOP = 1450;
const MESSAGE_FONT_SIZE = 36;
const MESSAGE_LINE_HEIGHT = 47;
const MESSAGE_TIME_SIZE = 22;
const FONT_CAP_HEIGHT = FONT.capHeight / FONT.unitsPerEm;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function textWidth(value, size) {
  let width = 0;
  let run = '';
  const flush = () => {
    if (!run) return;
    const layout = FONT.layout(run);
    width += layout.positions.reduce((sum, item) => sum + item.xAdvance, 0) * size / FONT.unitsPerEm;
    run = '';
  };
  for (const character of Array.from(String(value))) {
    if (EMOJI_ASSET_BY_GLYPH.has(character) && EMOJI_ASSET_BY_GLYPH.get(character)) {
      flush();
      width += size;
    } else if (character !== '\uFE0F') run += character;
  }
  flush();
  return width;
}

function shorten(value, width, size) {
  let result = String(value);
  while (result.length && textWidth(result, size) > width) result = `${result.slice(0, -2)}…`;
  return result;
}

function wrap(value, width, size) {
  const result = [];
  for (const paragraph of String(value ?? '').trim().split(/\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && textWidth(candidate, size) > width) { result.push(line); line = word; }
      else line = candidate;
    }
    if (line) result.push(line);
  }
  return result.length ? result : [''];
}

function wrapForBubble(value, width, size, time, timeSize = MESSAGE_TIME_SIZE) {
  const lines = wrap(value, width, size);
  const timeReserve = textWidth(time, timeSize) + 18;
  while (lines.length > 1 && textWidth(lines.at(-1), size) + timeReserve > width) {
    const words = lines.at(-1).split(' ');
    if (words.length < 2) break;
    const moved = words.pop();
    lines[lines.length - 1] = words.join(' ');
    lines.push(moved);
  }
  return lines;
}

function inlineTextSvg(value, x, baseline, size, color = '#0f1614', weight = 400) {
  let svg = '';
  let cursor = x;
  let run = '';
  const flush = () => {
    if (!run) return;
    svg += `<text xml:space="preserve" x="${cursor}" y="${baseline}" font-size="${size}" fill="${color}" font-weight="${weight}">${esc(run)}</text>`;
    cursor += textWidth(run, size);
    run = '';
  };
  for (const character of Array.from(String(value))) {
    const emoji = EMOJI_ASSET_BY_GLYPH.get(character);
    if (emoji) {
      flush();
      const emojiY = baseline - (size + size * FONT_CAP_HEIGHT) / 2;
      svg += `<image href="data:image/png;base64,${emoji}" x="${cursor}" y="${emojiY}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
      cursor += size;
    } else if (character !== '\uFE0F') run += character;
  }
  flush();
  return svg;
}

function linesSvg(lines, x, y, size, leading, color = '#0f1614', weight = 400) {
  return lines.map((line, i) => inlineTextSvg(line, x, y + i * leading, size, color, weight)).join('');
}

function wallpaper(seed) {
  return `<defs><linearGradient id="sent" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#dbffb0"/><stop offset="1" stop-color="#cfff98"/></linearGradient><filter id="glass" x="-20%" y="-30%" width="140%" height="180%"><feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#527e54" flood-opacity=".16"/></filter><clipPath id="wallClip"><rect x="62" y="0" width="742" height="1600"/></clipPath><clipPath id="chatClip"><rect x="62" y="${CHAT_TOP}" width="742" height="${COMPOSER_TOP - CHAT_TOP}"/></clipPath></defs><rect width="900" height="1600" fill="#b7cea0"/><image href="data:image/jpeg;base64,${WALLPAPER_DATA}" x="62" y="0" width="742" height="1600" preserveAspectRatio="xMidYMid slice"/>`;
}

async function telegramIcon(name, size, tint) {
  const key = `${name}:${size}:${tint || ''}`;
  if (!iconCache.has(key)) {
    iconCache.set(key, (async () => {
      const source = sharp(path.join(TELEGRAM_ICON_DIR, name));
      let image = source;
      if (tint) {
        const { data, info } = await source.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const color = tint.match(/[\da-f]{2}/gi).map((channel) => Number.parseInt(channel, 16));
        for (let i = 0; i < data.length; i += 4) {
          data[i] = color[0];
          data[i + 1] = color[1];
          data[i + 2] = color[2];
        }
        image = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
      }
      return image.resize(size, size, { fit: 'contain' }).png().toBuffer();
    })());
  }
  return (await iconCache.get(key)).toString('base64');
}

function initials(name) {
  const words = String(name || 'Contacto')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[\p{L}\p{N}]+/gu) || ['C'];
  const useful = words.filter((word) => !['ia', 'vip', 'comunidad'].includes(word.toLowerCase()));
  const source = useful.length ? useful : words;
  const result = source.length > 1
    ? `${Array.from(source[0])[0]}${Array.from(source[1])[0]}`
    : Array.from(source[0]).slice(0, 2).join('');
  return result.toLocaleUpperCase('es');
}

function header(scene, backIcon) {
  const contact = scene.contact || { name: 'Contacto', emoji: '' };
  const name = shorten(contact.name, 330 - (contact.emoji ? 38 : 0), 29);
  const nameWidth = textWidth(name, 29);
  const nameEmojiWidth = contact.emoji ? 34 : 0;
  const nameX = 468 - (nameWidth + nameEmojiWidth) / 2;
  const nameContent = `${inlineTextSvg(name, nameX, 151, 29, '#0f1614', 700)}${contact.emoji ? inlineTextSvg(contact.emoji, nameX + nameWidth + 5, 151, 29, '#0f1614', 700) : ''}`;
  const counter = 71 + ((Number(scene.avatarAsset) || 0) * 31) % 800;
  const parsedBattery = Number.parseInt(scene.batteryPercent, 10);
  const batteryPercent = Number.isFinite(parsedBattery) ? Math.min(100, Math.max(1, parsedBattery)) : 87;
  // iPhone low-battery glyph: an olive body, colored level at its left edge,
  // white percentage centered over the body, and a small terminal on the right.
  const batteryWidth = 57 * batteryPercent / 100;
  const batteryColor = batteryPercent <= 20 ? '#ff3448' : '#91d987';
  const batteryFontSize = batteryPercent >= 100 ? 13 : batteryPercent >= 10 ? 18 : 19;
  const statusTime = String(scene.statusTime || '7:19');
  const connectionStatus = String(scene.connectionStatus || 'últ. vez hace 8 minutos');
  const connectionColor = connectionStatus === 'en línea' ? '#3390ec' : '#66766a';
  const statusTimeX = 160;
  const fallbackColors = ['#456c93', '#8062a8', '#ad725e', '#4c8279', '#ac6e89', '#546d9d'];
  const color = /^#[0-9a-f]{6}$/i.test(contact.color || '') ? contact.color : fallbackColors[Math.abs(Number(scene.avatarAsset) || 0) % fallbackColors.length];
  const label = initials(contact.name);
  const statusIcons = `<g fill="none" stroke="#111914" stroke-linecap="round" stroke-linejoin="round">
    <!-- Baseline and optical weight tuned to the time and battery centerline. -->
    <g transform="translate(-26 0)" fill="#111914" stroke="none"><rect x="658" y="67" width="6" height="11" rx="2.7"/><rect x="668" y="61" width="6" height="17" rx="2.7"/><rect x="678" y="55" width="6" height="23" rx="2.7"/><rect x="688" y="49" width="6" height="29" rx="2.7"/></g>
    <!-- Keep Wi-Fi close to the signal bars and centered vertically in the row. -->
    <g transform="translate(-44 1)" fill="#111914" stroke="none"><path d="M718 55c10-9.2 25.8-9.2 35.8 0l-4.2 4.3c-7.7-7.1-19.7-7.1-27.4 0L718 55Z"/><path d="M724 63c6.7-6.2 17.2-6.2 23.9 0l-4.2 4.3c-4.3-4-11.2-4-15.5 0L724 63Z"/><circle cx="735.9" cy="73.8" r="2.8"/></g>
  </g>`;
  const battery = `<g transform="translate(-52 0)" aria-label="Batería ${batteryPercent}%"><rect x="773" y="50" width="61" height="30" rx="9" fill="#65794b"/><rect x="773" y="50" width="${batteryWidth}" height="30" rx="9" fill="${batteryColor}"/><rect x="773" y="50" width="61" height="30" rx="9" fill="none" stroke="#536744" stroke-width="1.5"/><path d="M836 59h4v12h-4z" fill="#65794b"/><text x="803.5" y="72" text-anchor="middle" font-size="${batteryFontSize}" font-weight="700" fill="#fff">${batteryPercent}</text></g>`;
  const statusBar = `<text x="${statusTimeX}" y="75" font-size="29" font-weight="650">${esc(statusTime)}</text>${statusIcons}${battery}`;
  return `${statusBar}<g filter="url(#glass)"><rect x="108" y="116" width="149" height="72" rx="36" fill="#eff8df" fill-opacity=".78"/><image href="data:image/png;base64,${backIcon}" x="127" y="130" width="48" height="48"/><rect x="169" y="133" width="68" height="39" rx="20" fill="#101713"/><text x="203" y="160" text-anchor="middle" font-size="23" fill="#fff">${counter}</text><rect x="289" y="116" width="357" height="72" rx="36" fill="#f4fae8" fill-opacity=".81"/>${nameContent}<text x="468" y="177" text-anchor="middle" font-size="19" fill="${connectionColor}">${esc(connectionStatus)}</text><circle cx="744" cy="148" r="39" fill="#f6f9e9" fill-opacity=".93"/><circle cx="744" cy="148" r="34" fill="${esc(color)}"/><text x="744" y="158" text-anchor="middle" font-size="25" font-weight="650" fill="#fff">${esc(label)}</text></g>`;
}

async function media(scene) {
  const source = scene.referencePath || await tradeImage(scene);
  const meta = await sharp(source).metadata();
  // Trade screenshots have a large empty canvas below their summary. Crop only
  // that blank tail so the operations and balance remain legible in the chat.
  const contentBottom = scene.referencePath
    ? Number(scene.referenceTopHeight) || 650
    : 210 + (scene.rows?.length || 3) * 83 + 5 * 32;
  const h = Math.min(meta.height, Math.max(390, contentBottom + 28));
  const input = await sharp(source)
    .extract({ left: 0, top: 0, width: meta.width, height: h })
    .png()
    .toBuffer();
  const scale = Math.min(488 / meta.width, 690 / h);
  const width = Math.round(meta.width * scale);
  const height = Math.round(h * scale);
  return { buffer: await sharp(input).resize(width, height, { fit: 'fill' }).png().toBuffer(), width, height };
}

async function sticker(index) {
  const directory = path.join(ROOT, 'assets', 'stickers', 'wall-street');
  const excluded = new Set([
    '0ecf9610e1cf4ca9f23d5b0a1d7e2c14.webp', // caída
    '3693f8c6440da3d61342aa501436d62c.webp', // sticker de otro personaje
    'a2ce1401b7e866445f5e906af15dfc1f.webp', // persona caída
    'c540b0ae7b44c02d6923ae1d0ee1800a.webp' // incluye texto ajeno al paquete
  ]);
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.webp') && !excluded.has(file)).sort();
  return sharp(path.join(directory, files[Math.abs(Number(index) || 0) % files.length]))
    .resize(290, 270, { fit: 'contain' }).png().toBuffer();
}

function composer(icons) {
  return `<g filter="url(#glass)"><circle cx="162" cy="1511" r="35" fill="#f2f9e6" fill-opacity=".89" stroke="#c5d7b8" stroke-width="1.5"/><image href="data:image/png;base64,${icons.attach}" x="133" y="1482" width="58" height="58"/><rect x="211" y="1475" width="480" height="72" rx="36" fill="#f1f9e2" fill-opacity=".89" stroke="#c6d8ba" stroke-width="1.5"/><text x="239" y="1521" font-size="27" fill="#879787">Mensaje</text><image href="data:image/png;base64,${icons.schedule}" x="628" y="1489" width="44" height="44"/><circle cx="736" cy="1511" r="35" fill="#f2f9e6" fill-opacity=".89" stroke="#c5d7b8" stroke-width="1.5"/><image href="data:image/png;base64,${icons.mic}" x="707" y="1482" width="58" height="58"/></g>`;
}

function incomingBubble({ x, y, maxWidth = 620, lines, time }) {
  const fontSize = MESSAGE_FONT_SIZE;
  const leading = MESSAGE_LINE_HEIGHT;
  const textWidthMax = Math.max(...lines.map((line) => textWidth(line, fontSize)));
  const lastRowWithTime = textWidth(lines.at(-1), fontSize) + textWidth(time, MESSAGE_TIME_SIZE) + 35;
  const width = Math.min(maxWidth, Math.max(190, Math.ceil(Math.max(textWidthMax + 36, lastRowWithTime))));
  const height = 20 + lines.length * leading;
  const baseline = y + 40 + (lines.length - 1) * leading;
  return { width, height, svg: `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="23" fill="#fff"/><path d="M${x + 16} ${y + height - 14}q-12 12-22 12q10-8 8-24" fill="#fff"/>${linesSvg(lines, x + 18, y + 40, fontSize, leading)}<text x="${x + width - 15}" y="${baseline}" text-anchor="end" font-size="${MESSAGE_TIME_SIZE}" fill="#7e8582">${esc(time)}</text>` };
}

function outgoingBubble({ x, y, width, lines, time }, readChecks) {
  const fontSize = MESSAGE_FONT_SIZE;
  const leading = MESSAGE_LINE_HEIGHT;
  const height = 20 + lines.length * leading;
  const checksX = x + width - 43;
  const baseline = y + 40 + (lines.length - 1) * leading;
  return { height, svg: `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="24" fill="url(#sent)"/><path d="M${x + width - 16} ${y + height - 15}q13 13 25 13q-12 2-25-2" fill="#cfff98"/>${linesSvg(lines, x + 18, y + 40, fontSize, leading)}<text x="${checksX - 4}" y="${baseline}" text-anchor="end" font-size="${MESSAGE_TIME_SIZE}" fill="#549161">${esc(time)}</text><image href="data:image/png;base64,${readChecks}" x="${checksX}" y="${baseline - 26}" width="24" height="24"/>` };
}

export async function renderTelegramChat(scene) {
  const variant = ((Number(scene.layoutVariant) || 0) % 3 + 3) % 3;
  const icons = {
    back: await telegramIcon('headerback.png', 58, '#17202a'),
    attach: await telegramIcon('ModernConversationAttach@3x.png', 70),
    mic: await telegramIcon('ModernConversationMicButton@3x.png', 70),
    schedule: await telegramIcon('ScheduleInput@3x (2).png', 52),
    readChecks: await telegramIcon('readchecks_telegram.png', 42, '#549161')
  };
  const photo = await media(scene);
  const incoming = String(scene.messages?.find((message) => message.role === 'received')?.text || scene.message || '').replace(/\s+/g, ' ').trim();
  const reply = String(scene.messages?.find((message) => message.role === 'sent')?.text || scene.reply || '').replace(/\s+/g, ' ').trim();
  const responseImageRequested = scene.showSticker === undefined ? !scene.loss : Boolean(scene.showSticker);
  const incomingTime = scene.chatTime || '7:10 PM';
  const replyTime = scene.replyTime || '7:17 PM';
  const incomingLines = wrapForBubble(incoming, 540, MESSAGE_FONT_SIZE, incomingTime);
  const replyLines = wrapForBubble(reply, 510, MESSAGE_FONT_SIZE, replyTime);
  const photoX = 112;
  const photoY = 174;
  const mediaBoxW = photo.width + 12;
  // Reserve only a compact footer after the data table for Telegram's media
  // timestamp. Keeping it outside the source pixels prevents covering Balance.
  const mediaBoxH = photo.height + 54;
  const message = incomingBubble({ x: 112, y: photoY + mediaBoxH + 10, maxWidth: 620, lines: incomingLines, time: incomingTime });
  const responseWidth = Math.min(630, Math.max(260, Math.ceil(Math.max(...replyLines.map((line) => textWidth(line, MESSAGE_FONT_SIZE)), textWidth(replyLines.at(-1), MESSAGE_FONT_SIZE) + textWidth(replyTime, MESSAGE_TIME_SIZE) + 40) + 38)));
  const responseX = 780 - responseWidth;
  const responseY = photoY + mediaBoxH + message.height + 18;
  const textResponse = outgoingBubble({ x: responseX, y: responseY, width: responseWidth, lines: replyLines, time: replyTime }, icons.readChecks);
  const imageY = responseY;
  const stickerReply = outgoingBubble({ x: responseX, y: imageY + 280, width: responseWidth, lines: replyLines, time: replyTime }, icons.readChecks);
  const stickerHeight = 280 + stickerReply.height;
  // Keep tall trade receipts complete. Use a text reply when a sticker would
  // force the receipt or the reply underneath the fixed composer.
  const responseImage = responseImageRequested && responseY + stickerHeight <= COMPOSER_TOP - 18;
  const stickerPng = responseImage ? (await sticker(scene.stickerAsset ?? scene.avatarAsset)).toString('base64') : '';
  const imageResponse = `<g><image href="data:image/png;base64,${stickerPng}" x="490" y="${imageY}" width="290" height="270" preserveAspectRatio="xMidYMid meet"/><text x="738" y="${imageY + 252}" text-anchor="end" font-size="16" fill="#fff" stroke="#4f6d52" stroke-opacity=".38" stroke-width="1">${esc(replyTime)}</text><image href="data:image/png;base64,${icons.readChecks}" x="742" y="${imageY + 232}" width="25" height="25"/>${stickerReply.svg}</g>`;
  const responseHeight = responseImage ? stickerHeight : textResponse.height;
  const bottom = responseY + responseHeight;
  // A small scroll offset varies the third layout while preserving the rows at
  // the top of the attached trading screenshot.
  const scroll = Math.min(Math.max(0, bottom - (COMPOSER_TOP - 18)) + (variant === 2 ? 32 : 0), 60);
  const mediaTop = photoY - scroll;
  const msgTop = photoY + mediaBoxH + 10 - scroll;
  const resTop = responseY - scroll;
  const attachmentTime = scene.chatTime || '7:08 PM';
  const mediaTimeY = mediaTop + photo.height + 13;
  const attachment = `<rect x="${photoX}" y="${mediaTop}" width="${mediaBoxW}" height="${mediaBoxH}" rx="20" fill="#fff"/><defs><clipPath id="mediaMask"><rect x="${photoX + 6}" y="${mediaTop + 6}" width="${photo.width}" height="${photo.height}" rx="15"/></clipPath></defs><g clip-path="url(#mediaMask)"><image href="data:image/png;base64,${photo.buffer.toString('base64')}" x="${photoX + 6}" y="${mediaTop + 6}" width="${photo.width}" height="${photo.height}"/></g><rect x="${photoX + mediaBoxW - 112}" y="${mediaTimeY}" width="96" height="32" rx="16" fill="#777" fill-opacity=".72"/><text x="${photoX + mediaBoxW - 24}" y="${mediaTimeY + 22}" text-anchor="end" font-size="${MESSAGE_TIME_SIZE}" fill="#fff">${esc(attachmentTime)}</text>`;
  const shiftedMessage = incomingBubble({ x: 112, y: msgTop, maxWidth: 620, lines: incomingLines, time: incomingTime }).svg;
  const shiftedResponse = responseImage
    ? `<g transform="translate(0 ${resTop - imageY})">${imageResponse}</g>`
    : outgoingBubble({ x: responseX, y: resTop, width: responseWidth, lines: replyLines, time: replyTime }, icons.readChecks).svg;
  const labelY = variant === 2 ? 198 : 203;
  const disclosure = `<g><rect x="620" y="${labelY}" width="184" height="27" rx="14" fill="#f4f8e8" fill-opacity=".9"/><text x="712" y="${labelY + 18}" text-anchor="middle" font-size="12" font-weight="700" fill="#536b55">CONTENIDO GENERADO</text></g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>@font-face{font-family:ChatInter;src:url(data:font/ttf;base64,${FONT_DATA}) format('truetype')}text{font-family:ChatInter,Arial,sans-serif}</style>${wallpaper(variant)}<g clip-path="url(#chatClip)">${attachment}${shiftedMessage}${shiftedResponse}</g>${disclosure}${header(scene, icons.back)}${composer(icons)}<rect x="338" y="1580" width="224" height="7" rx="4" fill="#111812"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export const telegramImageSize = { width: W, height: H };
