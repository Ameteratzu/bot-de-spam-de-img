import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const compositor = await fs.readFile(path.join(root, 'telegram-compositor.js'), 'utf8');
const codes = [...new Set([...compositor.matchAll(/\['[^']+', '([0-9a-f]+)'\]/g)].map((match) => match[1].toUpperCase()))];
const outputDir = path.join(root, 'assets', 'emoji', 'telemoji');
const headers = { 'User-Agent': 'ChatImageStudio/1.0 (local asset preparation)' };

await fs.mkdir(outputDir, { recursive: true });
const treeResponse = await fetch('https://api.github.com/repos/saeedtahmtan/telemoji/git/trees/main?recursive=1', { headers });
if (!treeResponse.ok) throw new Error(`Could not read Telemoji asset index (${treeResponse.status}).`);
const tree = (await treeResponse.json()).tree;
const converted = [];
const missing = [];

for (const code of codes) {
  const entry = tree.find(({ path: itemPath }) => new RegExp(`^webp/animated/U\\+${code}(?:_\\d+)?\\.webp$`).test(itemPath));
  if (!entry) { missing.push(code); continue; }

  const response = await fetch(`https://media.githubusercontent.com/media/saeedtahmtan/telemoji/main/${entry.path}`, { headers });
  if (!response.ok) throw new Error(`Could not fetch ${entry.path} (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const output = path.join(outputDir, `${code.toLowerCase()}.png`);
  await sharp(bytes, { page: 0 }).resize(128, 128, { fit: 'contain' }).png().toFile(output);
  converted.push(code);
  process.stdout.write(`Rendered Telegram emoji U+${code}\n`);
}

await fs.writeFile(path.join(outputDir, 'README.md'), `# Telegram animated emoji frames\n\nThese local PNGs are the first frames of Telegram animated emoji, rasterized for static chat-image output. The source package is [saeedtahmtan/telemoji](https://github.com/saeedtahmtan/telemoji), which credits the original animations to Telegram.\n\nThis project uses the artwork as a local visual reference for its chat compositor. Telegram retains rights to its Telemoji artwork; follow Telegram's terms for any distribution or commercial use.\n\nPrepared assets: ${converted.join(', ')}.\n${missing.length ? `\nNot present in the source package: ${missing.join(', ')}.\n` : ''}`);
process.stdout.write(`Prepared ${converted.length} emoji frames${missing.length ? `; unavailable: ${missing.join(', ')}` : ''}.\n`);
