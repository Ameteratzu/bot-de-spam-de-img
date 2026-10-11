import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { darkenTradeScreenshot } from '../trade-dark.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(root, 'references', 'trading-history');
const outputDir = path.join(sourceDir, 'dark');
await fs.mkdir(outputDir, { recursive: true });
for (let number = 1; number <= 7; number++) {
  const name = `${String(number).padStart(2, '0')}.png`;
  const image = await darkenTradeScreenshot(path.join(sourceDir, name));
  await fs.writeFile(path.join(outputDir, name), image);
}
console.log('Siete referencias oscuras preparadas.');
