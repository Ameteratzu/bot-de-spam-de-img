import 'dotenv/config';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';

const base = 'http://localhost:3000';
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.ALEXANDER_EMAIL || 'alexander@testimoniostelegram.com', password: process.env.ALEXANDER_PASSWORD }) });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];
const db = new Database(path.resolve('data/studio.sqlite'), { readonly: true });
let previousName = null;
let previousVariant = null;
for (let n = 0; n < 10; n++) {
  const preview = await fetch(`${base}/api/preview-template`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: n % 5 === 3 ? 'loss' : 'gain' }) });
  assert.equal(preview.status, 200);
  const data = await preview.json();
  const scene = JSON.parse(db.prepare('SELECT scene_json FROM template_previews WHERE token = ?').get(data.previewToken).scene_json);
  assert.notEqual(scene.contact.name, previousName, `contact ${n}`);
  assert.notEqual(scene.layoutVariant, previousVariant, `layout ${n}`);
  previousName = scene.contact.name;
  previousVariant = scene.layoutVariant;
  const saved = await fetch(`${base}/api/generate-template`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ previewToken: data.previewToken }) });
  assert.equal(saved.status, 201, `save ${n}`);
}
db.close();
console.log('10 consecutive scenes: no adjacent contact or layout repeats; saved to gallery');
