import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { themeForAutomaticSlot } from '../scene-theme.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(root, '.env') });
const db = new Database(path.join(root, 'data', 'studio.sqlite'), { readonly: true });
const base = `http://localhost:${process.env.PORT || 3000}`;
const login = await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.LOGIN_EMAIL, password: process.env.LOGIN_PASSWORD })
});
assert.equal(login.status, 200, `Login HTTP ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const post = async (url, body) => {
  const response = await fetch(`${base}${url}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}: ${await response.text()}`);
  return response.json();
};
const get = async (url) => {
  const response = await fetch(`${base}${url}`, { headers: { cookie } });
  assert.ok(response.ok, `${url} HTTP ${response.status}`);
  return response;
};

const slots = Array.from({ length: 10 }, (_, slot) => themeForAutomaticSlot(slot));
assert.equal(slots.filter((theme) => theme === 'night').length, 5);
assert.equal(slots.filter((theme) => theme === 'day').length, 5);

const first = await post('/api/preview-template', { outcome: 'gain' });
const firstScene = JSON.parse(db.prepare('SELECT scene_json FROM template_previews WHERE token = ?').get(first.previewToken).scene_json);
const next = await post('/api/preview-template', { outcome: 'gain' });
const nextScene = JSON.parse(db.prepare('SELECT scene_json FROM template_previews WHERE token = ?').get(next.previewToken).scene_json);
assert.notEqual(firstScene.theme, nextScene.theme);
const night = firstScene.theme === 'night' ? first : next;
const nightScene = firstScene.theme === 'night' ? firstScene : nextScene;
const revised = await post('/api/preview-template', { previewToken: night.previewToken, message: nightScene.message, reply: nightScene.reply });
const revisedScene = JSON.parse(db.prepare('SELECT scene_json FROM template_previews WHERE token = ?').get(revised.previewToken).scene_json);
assert.equal(revisedScene.theme, 'night');
const preview = Buffer.from(await (await get(revised.previewUrl)).arrayBuffer());
const saved = await post('/api/generate-template', { previewToken: revised.previewToken });
const file = Buffer.from(await (await get(saved.image.url)).arrayBuffer());
assert.deepEqual(preview, file);
const gallery = await (await get('/api/images')).json();
assert.ok(JSON.stringify(gallery).includes(saved.image.id));
const output = path.join(root, 'generated', 'night-manual-verified.png');
fs.writeFileSync(output, file);
console.log(JSON.stringify({ automaticThemes: slots, firstManualTheme: firstScene.theme, secondManualTheme: nextScene.theme, previewEqualsSaved: true, galleryContainsSaved: true, output }));
