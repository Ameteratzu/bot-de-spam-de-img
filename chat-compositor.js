import sharp from 'sharp';

const WIDTH = 900;
const HEIGHT = 1600;
const xml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const svg = (content) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${content}</svg>`);

function measure(text, size) {
  return [...text].reduce((width, char) => width + size * (/[il.,!;:' |]/.test(char) ? .29 : /[MW@#%]/.test(char) ? .84 : /[\u{1F300}-\u{1FAFF}]/u.test(char) ? 1 : .53), 0);
}

function wrap(text, width, size, maxLines = 12) {
  const lines = [];
  let line = '';
  for (const word of String(text ?? '').trim().split(/\s+/)) {
    if (!word) continue;
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, size) > width) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const result = lines.slice(0, maxLines);
  result[maxLines - 1] += '…';
  return result;
}

function textBlock(lines, x, y, size, spacing, color = '#111') {
  return lines.map((line, index) => `<text x="${x}" y="${y + index * spacing}" font-family="Arial,sans-serif" font-size="${size}" fill="${color}">${xml(line)}</text>`).join('');
}

function background(seed) {
  const shapes = [];
  for (let y = 195; y < 1500; y += 136) {
    for (let x = 20; x < 900; x += 145) {
      const px = x + ((y + seed * 17) % 54);
      const py = y + ((x + seed * 13) % 39);
      const kind = (Math.floor(x / 145) + Math.floor(y / 136) + seed) % 4;
      if (kind === 0) shapes.push(`<circle cx="${px}" cy="${py}" r="19"/><circle cx="${px}" cy="${py}" r="7"/>`);
      else if (kind === 1) shapes.push(`<path d="M${px} ${py}c-17-21-31 2 0 27c31-25 17-48 0-27z"/>`);
      else if (kind === 2) shapes.push(`<path d="M${px-15} ${py+12}q15-31 30 0q-15 12-30 0z"/>`);
      else shapes.push(`<path d="M${px-15} ${py-15}l30 30m0-30l-30 30"/>`);
    }
  }
  return `<defs><linearGradient id="wall" x2="1" y2="1"><stop stop-color="#bedca4"/><stop offset=".55" stop-color="#91c9a8"/><stop offset="1" stop-color="#cbdca5"/></linearGradient><linearGradient id="sent" x2="1" y2="1"><stop stop-color="#d9fbbd"/><stop offset="1" stop-color="#eaffd2"/></linearGradient></defs><rect width="900" height="1600" fill="url(#wall)"/><g fill="none" stroke="#619c7c" stroke-width="2" opacity=".2">${shapes.join('')}</g>`;
}

function header(scene) {
  const c = scene.contact || { name: 'Contacto', color: '#698a78' };
  const name = `${c.name}${c.emoji ? ` ${c.emoji}` : ''}`;
  const title = measure(name, 29) > 505 ? `${name.slice(0, 25)}…` : name;
  const avatar = Number(scene.avatarAsset || 0) % 5;
  const skin = ['#ca9473', '#a36d50', '#e1b38d', '#b47c5c', '#d8a17c'][avatar];
  const hair = ['#352b2b', '#4a382e', '#262831', '#694534', '#30282b'][avatar];
  return `<rect width="900" height="155" fill="#eff8e8" opacity=".9"/><text x="45" y="50" font-family="Arial" font-size="29" font-weight="700">${xml(scene.statusTime || '10:28')}</text><path d="M739 47V36m11 11V31m11 16V25" stroke="#111" stroke-width="6"/><text x="816" y="49" font-family="Arial" font-size="24">◖ 78%</text><rect x="24" y="69" width="145" height="73" rx="36" fill="#f8fff0" opacity=".8"/><text x="43" y="123" font-family="Arial" font-size="62">‹</text><rect x="79" y="86" width="70" height="39" rx="19" fill="#111"/><text x="114" y="113" text-anchor="middle" font-family="Arial" font-size="23" fill="#fff">${70 + Number(scene.layoutVariant || 0) * 7}</text><rect x="202" y="68" width="518" height="74" rx="37" fill="#f9fff2" opacity=".83"/><text x="460" y="103" text-anchor="middle" font-family="Arial" font-size="29" font-weight="700">${xml(title)}</text><text x="460" y="130" text-anchor="middle" font-family="Arial" font-size="19" fill="#737b72">últ. vez hace un momento</text><defs><clipPath id="avatar"><circle cx="810" cy="101" r="38"/></clipPath></defs><circle cx="810" cy="101" r="42" fill="#fff"/><g clip-path="url(#avatar)"><rect x="770" y="60" width="80" height="82" fill="${xml(c.color || '#698a78')}"/><path d="M771 149q39-61 78 0" fill="#eee5da"/><ellipse cx="810" cy="101" rx="22" ry="27" fill="${skin}"/><path d="M787 101q-6-38 23-38q31 0 24 38q-7-20-24-17q-14-1-23 17z" fill="${hair}"/><circle cx="802" cy="103" r="2"/><circle cx="818" cy="103" r="2"/><path d="M802 117q8 6 16 0" fill="none" stroke="#704d3d" stroke-width="2"/></g>`;
}

function footer() {
  return `<rect x="0" y="1489" width="900" height="111" fill="#e4eddd" opacity=".3"/><circle cx="78" cy="1543" r="40" fill="#f9fff4"/><text x="78" y="1556" text-anchor="middle" font-family="Arial" font-size="42">⌁</text><rect x="138" y="1505" width="651" height="77" rx="38" fill="#f9fff4" opacity=".95"/><text x="163" y="1553" font-family="Arial" font-size="28" fill="#9ba69a">Mensaje</text><circle cx="842" cy="1543" r="40" fill="#f9fff4"/><text x="842" y="1553" text-anchor="middle" font-family="Arial" font-size="31">◉</text>`;
}

export async function tradeImage(scene) {
  const rows = scene.rows || [];
  const entries = rows.map((row, index) => {
    const y = 165 + index * 83;
    const sideColor = row.side === 'sell' ? '#ca4c41' : '#1888d1';
    const amountColor = row.amount < 0 ? '#be4d43' : '#1888d1';
    return `<text x="13" y="${y}" font-family="Arial" font-size="21" font-weight="700">XAUUSD <tspan fill="${sideColor}">${xml(row.side)} 0.0${xml(row.lot)}</tspan></text><text x="605" y="${y}" text-anchor="end" font-family="Arial" font-size="21" font-weight="700" fill="${amountColor}">${xml(row.amountText)}</text><text x="13" y="${y + 27}" font-family="Arial" font-size="17" fill="#6c6c6c">${xml(row.entryText)} → ${xml(row.closeText)}</text><text x="605" y="${y + 27}" text-anchor="end" font-family="Arial" font-size="17" fill="#6c6c6c">${xml(scene.date)} ${xml(row.time)}</text>`;
  }).join('');
  const summary = scene.summary || {};
  const sumY = 178 + rows.length * 83;
  const labels = [['Depósito', summary.depositText], ['Beneficio', summary.profitText], ['Swap', summary.swapText], ['Comisión', '0.00'], ['Balance', summary.balanceText]];
  const totals = labels.map(([label, value], index) => `<text x="13" y="${sumY + index * 32}" font-family="Arial" font-size="21">${xml(label)}</text><text x="605" y="${sumY + index * 32}" text-anchor="end" font-family="Arial" font-size="21">${xml(value)}</text>`).join('');
  const contents = `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="1280"><rect width="620" height="1280" fill="#fff"/><rect x="85" y="24" width="445" height="58" rx="29" fill="#f7f7f7"/><text x="147" y="62" font-family="Arial" font-size="24">Posiciones</text><text x="304" y="62" font-family="Arial" font-size="24">Órdenes</text><text x="445" y="62" font-family="Arial" font-size="22">Transacci…</text>${entries}${totals}<rect x="22" y="1190" width="576" height="70" rx="35" fill="#f8f9f8"/><text x="105" y="1230" font-family="Arial" font-size="19">Cotizaciones</text><text x="282" y="1230" font-family="Arial" font-size="19">Trading</text><text x="456" y="1230" font-family="Arial" font-size="19" fill="#1684cf">Historial</text></svg>`;
  return sharp(Buffer.from(contents)).png().toBuffer();
}

async function photo(scene, width, height) {
  const source = scene.referencePath || await tradeImage(scene);
  const metadata = await sharp(source).metadata();
  const requestedTop = scene.referencePath ? scene.referenceTopHeight : 210 + (scene.rows?.length || 3) * 83 + 5 * 32;
  const topHeight = Math.min(requestedTop || 650, metadata.height - 130);
  const top = await sharp(source).extract({ left: 0, top: 0, width: metadata.width, height: topHeight }).png().toBuffer();
  const showNav = scene.attachmentCrop === 'full';
  const navHeight = 125;
  const sourceHeight = Math.max(topHeight + (showNav ? navHeight : 0) + 35, Math.round(height * metadata.width / width));
  const layers = [{ input: top, left: 0, top: 0 }];
  if (showNav) layers.push({ input: await sharp(source).extract({ left: 0, top: metadata.height - navHeight, width: metadata.width, height: navHeight }).png().toBuffer(), left: 0, top: sourceHeight - navHeight });
  const built = await sharp({ create: { width: metadata.width, height: sourceHeight, channels: 4, background: '#fff' } }).composite(layers).png().toBuffer();
  return sharp(built).resize(width, height, { fit: 'contain', background: '#fff' }).png().toBuffer();
}

export async function renderTradeChat(scene) {
  const variant = Number(scene.layoutVariant || 0) % 3;
  const separate = variant === 1;
  const message = String(scene.messages?.find((m) => m.role === 'received')?.text || scene.message || '').replace(/\s+/g, ' ').trim();
  const answer = String(scene.messages?.find((m) => m.role === 'sent')?.text || scene.reply || '').replace(/\s+/g, ' ').trim();
  const messageLines = wrap(message, 612, 27, separate ? 7 : 10);
  const answerLines = wrap(answer, 604, 28, 5);
  const photoWidth = [550, 490, 585][variant];
  const photoX = 29;
  const photoY = variant === 2 ? 126 : 169;
  const photoHeight = Math.round(Math.max(separate ? 530 : 580, Math.min(separate ? 900 - messageLines.length * 30 : 890 - Math.max(0, messageLines.length - 3) * 32, photoWidth * 1.65)));
  const photoBottom = photoY + photoHeight;
  const messageHeight = 24 + messageLines.length * 35 + 34;
  const firstBottom = separate ? photoBottom + 12 : photoBottom + messageHeight + 12;
  const messageY = separate ? firstBottom + 13 : photoBottom + 19;
  const incomingBottom = separate ? messageY + messageHeight : firstBottom;
  const replyY = Math.min(incomingBottom + 17, 1364);
  const replyWidth = Math.min(690, Math.max(390, Math.max(0, ...answerLines.map((line) => measure(line, 28))) + 74));
  const replyX = 900 - replyWidth - 25;
  const replyHeight = 31 + answerLines.length * 38 + 30;
  const firstWidth = separate ? photoWidth + 20 : Math.max(photoWidth + 20, 680);
  let body = background(variant) + `<rect x="19" y="${photoY - 10}" width="${firstWidth}" height="${firstBottom - photoY + 20}" rx="25" fill="#fff"/>`;
  if (separate) body += `<rect x="19" y="${messageY - 13}" width="690" height="${messageHeight + 13}" rx="25" fill="#fff"/>`;
  body += `<rect x="${photoX}" y="${photoY}" width="${photoWidth}" height="${photoHeight}" rx="17" fill="#fff"/>`;
  body += textBlock(messageLines, 42, messageY + 19, 27, 35);
  body += `<text x="650" y="${incomingBottom - 13}" text-anchor="end" font-family="Arial" font-size="18" fill="#89918b">${xml(scene.chatTime || '10:15')}</text>`;
  body += `<rect x="${replyX}" y="${replyY}" width="${replyWidth}" height="${replyHeight}" rx="27" fill="url(#sent)"/><path d="M${replyX + replyWidth - 15} ${replyY + replyHeight - 12}l26 18-31-6" fill="#eaffd2"/>`;
  body += textBlock(answerLines, replyX + 22, replyY + 43, 28, 38);
  body += `<text x="${replyX + replyWidth - 15}" y="${replyY + replyHeight - 12}" text-anchor="end" font-family="Arial" font-size="17" fill="#4b9c5a">${xml(scene.replyTime || '10:17')} ✓✓</text>`;
  body += footer();
  const base = await sharp(svg(body)).png().toBuffer();
  const layers = [];
  const attachment = await photo(scene, photoWidth, photoHeight);
  if (attachment) layers.push({ input: attachment, left: photoX, top: photoY });
  const badge = `<rect x="648" y="183" width="231" height="38" rx="19" fill="#fbe3e6"/><text x="763" y="209" text-anchor="middle" font-family="Arial" font-size="19" font-weight="700" fill="#a12c3e"></text>`;
  layers.push({ input: svg(badge), left: 0, top: 0 });
  layers.push({ input: svg(header(scene)), left: 0, top: 0 });
  return sharp(base).composite(layers).png().toBuffer();
}
