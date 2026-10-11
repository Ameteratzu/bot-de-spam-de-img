import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { renderTelegramChat } from '../telegram-compositor.js';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'generated');
fs.mkdirSync(output, { recursive: true });
const cases = [
  { file: '05.png', top: 460, variant: 0, crop: 'full', battery: 13, sticker: 15, name: 'Valentina Cruz', message: 'Buenas tardes, bro. Gracias por la ayuda de hoy; revisar las entradas con calma me sirvió mucho.' },
  { file: '01.png', top: 1030, variant: 1, crop: 'lower-cut', battery: 56, sticker: 8, name: 'Sebastián Montenegro', message: 'Buenos días, líder. Te comparto el cierre de esta semana. Me alegró ver el resultado y agradezco el tiempo que dedicaste a explicarme el plan paso a paso. Seguiré practicando con paciencia.' },
  { file: '06.png', top: 530, variant: 2, crop: 'full', battery: 97, sticker: 12, name: 'Camila Torres', message: 'Buenas noches, pana. Ya vi las operaciones; gracias por acompañarme a revisar los números.' }
];

for (const [index, top] of [1030, 530, 530, 530, 460, 530, 660, 900].entries()) {
  const file = index === 7 ? path.join(root, 'references', 'trading-history', '08-night.png') : path.join(root, 'references', 'trading-history', 'dark', `${String(index + 1).padStart(2, '0')}.png`);
  const scene = {
    theme: 'night', contact: { name: 'Mateo Rojas', emoji: '🤖', color: '#456c93' }, avatarAsset: index,
    batteryPercent: 22 + index * 9, layoutVariant: index % 3, referencePath: file, referenceTopHeight: top,
    message: 'Buenas noches, bro. Te comparto cómo cerré hoy. Gracias por ayudarme a revisar las operaciones; seguimos aprendiendo y cuidando el riesgo. 🤖',
    reply: '¡Duro, mi hermano! Seguimos enfocados y con cabeza fría. 🔥',
    statusTime: '9:28', chatTime: '9:25 PM', replyTime: '9:28 PM'
  };
  const png = await renderTelegramChat(scene);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, 900);
  assert.equal(metadata.height, 1600);
  const outputPath = path.join(output, `qa-night-${String(index + 1).padStart(2, '0')}.png`);
  fs.writeFileSync(outputPath, png);
  process.stdout.write(`${outputPath}\n`);
}

for (const item of cases) {
  const scene = {
    contact: { name: item.name, emoji: '✦', color: '#659680' },
    avatarAsset: item.variant,
    stickerAsset: item.sticker,
    batteryPercent: item.battery,
    layoutVariant: item.variant,
    attachmentCrop: item.crop,
    referencePath: path.join(root, 'references', 'trading-history', item.file),
    referenceTopHeight: item.top,
    message: item.message,
    reply: '¡Felicitaciones! Sigamos con disciplina y cuidando el riesgo.',
    statusTime: '10:28', chatTime: '10:25', replyTime: '10:28'
  };
  const png = await renderTelegramChat(scene);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, 900);
  assert.equal(metadata.height, 1600);
  const file = path.join(output, `qa-telegram-${item.variant}.png`);
  fs.writeFileSync(file, png);
  process.stdout.write(`${file}\n`);
}

const lossScene = {
  contact: { name: 'Ana María Fernández y Asociados', emoji: '🌿' }, avatarAsset: 4, stickerAsset: 15, batteryPercent: 20,
  layoutVariant: 1, attachmentCrop: 'lower-cut', loss: true, date: '2026.10.09',
  rows: [0, 1].map((n) => ({ side: 'buy', lot: 5, entryText: '4 180.00', closeText: '4 170.00', amount: -50, amountText: '-50.00', time: `09:2${n}:00` })),
  summary: { depositText: '300.00', profitText: '-100.00', swapText: '0.00', balanceText: '200.00' },
  message: 'Buenas noches, hermano. Hoy cerré con una pérdida y quise compartirte las operaciones. Aprendí que me apresuré en la entrada. Gracias por ayudarme a revisar el riesgo y entender lo que pasó. Mañana vuelvo con más calma y respetando el plan.',
  reply: 'Gracias por compartirlo. Revisemos las entradas juntos y mantengamos la disciplina.',
  statusTime: '21:18', chatTime: '21:14', replyTime: '21:18'
};
const lossPng = await renderTelegramChat(lossScene);
assert.equal((await sharp(lossPng).metadata()).height, 1600);
const lossFile = path.join(output, 'qa-telegram-loss.png');
fs.writeFileSync(lossFile, lossPng);
process.stdout.write(`${lossFile}\n`);
const darkLossPng = await renderTelegramChat({ ...lossScene, theme: 'night', statusTime: '9:18', chatTime: '9:14 PM', replyTime: '9:18 PM' });
assert.equal((await sharp(darkLossPng).metadata()).height, 1600);
const darkLossFile = path.join(output, 'qa-night-loss.png');
fs.writeFileSync(darkLossFile, darkLossPng);
process.stdout.write(`${darkLossFile}\n`);
