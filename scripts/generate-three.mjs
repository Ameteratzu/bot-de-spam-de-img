import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(root, '.env') });
const base = `http://localhost:${process.env.PORT || 3000}`;
const login = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.ALEXANDER_EMAIL || 'alexander@testimoniostelegram.com', password: process.env.ALEXANDER_PASSWORD })
});
if (!login.ok) throw new Error(`Login HTTP ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('No se recibió la sesión.');

const count = Math.min(10, Math.max(1, Number(process.argv[2]) || 3));
const prefix = process.argv[3] || 'prueba-jefe-lider';
for (let index = 1; index <= count; index++) {
  const generated = await fetch(`${base}/api/generate-template`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'gain' })
  });
  if (!generated.ok) throw new Error(`Generación ${index}: HTTP ${generated.status} ${await generated.text()}`);
  const { image } = await generated.json();
  const response = await fetch(`${base}${image.url}`, { headers: { cookie } });
  if (!response.ok) throw new Error(`Descarga ${index}: HTTP ${response.status}`);
  const output = path.join(root, 'generated', `${prefix}-${index}.png`);
  fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
  console.log(output);
}
