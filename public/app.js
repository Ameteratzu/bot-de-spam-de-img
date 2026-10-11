const $ = (selector) => document.querySelector(selector);
const loginScreen = $('#login-screen');
const appShell = $('#app-shell');
const loginForm = $('#login-form');
const loginError = $('#login-error');
const generateForm = $('#generate-form');
const promptInput = $('#prompt');
const generateError = $('#generate-error');
const galleryGrid = $('#gallery-grid');
const emptyState = $('#empty-state');
const cardTemplate = $('#image-card-template');
let toastTimer;
let loginInProgress = false;
let editingPhraseId = null;
let previewToken = null;

async function api(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const response = await fetch(url, {
    credentials: 'same-origin',
    signal: controller.signal,
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  }).catch((error) => {
    if (error.name === 'AbortError') throw new Error('El servidor tardó demasiado en responder. Recarga la página e inténtalo de nuevo.');
    throw new Error('No se pudo conectar con el servidor local. Comprueba que siga activo.');
  }).finally(() => clearTimeout(timeout));
  let payload;
  try {
    payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : {};
  } catch {
    throw new Error('El servidor devolvió una respuesta inválida. Recarga la página e inténtalo de nuevo.');
  }
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') showLogin();
    throw new Error(payload.error || 'No se pudo completar la solicitud.');
  }
  return payload;
}

function showLogin() {
  appShell.classList.add('hidden');
  loginScreen.classList.remove('hidden');
}

function showApp() {
  loginScreen.classList.add('hidden');
  appShell.classList.remove('hidden');
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

function setUsage(today) {
  $('#quota-number').textContent = String(today);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatTime(value) {
  return new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function renderGallery(images) {
  galleryGrid.replaceChildren();
  for (const image of images) {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    const img = card.querySelector('img');
    img.src = image.url;
    img.alt = image.source === 'authentic' ? 'Captura original importada sin edición' : `Imagen de ${image.name}; escena ficticia creada con ${image.source === 'template' ? 'plantilla local' : 'inteligencia artificial'}`;
    card.querySelector('.image-title strong').textContent = image.name;
    card.querySelector('.image-time').textContent = formatTime(image.createdAt);
    card.querySelector('.prompt-preview').textContent = image.prompt;
    const download = card.querySelector('.download-button');
    download.href = image.downloadUrl;
    download.download = '';
    card.querySelector('.more-button').addEventListener('click', () => showToast(image.prompt));
    galleryGrid.append(card);
  }
  $('#gallery-count').textContent = String(images.length);
  $('#collection-total').textContent = `(${images.length})`;
  emptyState.classList.toggle('hidden', images.length > 0);
}

async function loadGallery() {
  const data = await api('/api/images');
  renderGallery(data.images);
  setUsage(data.today);
}

function resetPhraseForm() {
  editingPhraseId = null;
  $('#phrase-form').reset();
  $('#phrase-save').textContent = 'Guardar frase';
  $('#phrase-cancel').classList.add('hidden');
  $('#phrase-error').textContent = '';
}

async function loadPhrases() {
  const data = await api('/api/phrases');
  const list = $('#phrase-list');
  list.replaceChildren();
  for (const phrase of data.phrases) {
    const item = document.createElement('div');
    item.className = 'phrase-item';
    const content = document.createElement('div');
    const tag = document.createElement('span');
    tag.className = 'phrase-tag';
    tag.textContent = phrase.outcome === 'gain' ? 'GANANCIA' : 'PÉRDIDA';
    const body = document.createElement('p');
    body.textContent = phrase.body;
    content.append(tag, body);
    const actions = document.createElement('div');
    actions.className = 'phrase-item-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Editar';
    edit.addEventListener('click', () => {
      editingPhraseId = phrase.id;
      $('#phrase-outcome').value = phrase.outcome;
      $('#phrase-body').value = phrase.body;
      $('#phrase-save').textContent = 'Guardar cambios';
      $('#phrase-cancel').classList.remove('hidden');
      $('#phrase-body').focus();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Eliminar';
    remove.addEventListener('click', async () => {
      try {
        await api(`/api/phrases/${phrase.id}`, { method: 'DELETE' });
        if (editingPhraseId === phrase.id) resetPhraseForm();
        await loadPhrases();
      } catch (error) { $('#phrase-error').textContent = error.message; }
    });
    actions.append(edit, remove);
    item.append(content, actions);
    list.append(item);
  }
}

$('#phrase-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#phrase-error').textContent = '';
  const button = $('#phrase-save');
  button.disabled = true;
  try {
    await api(editingPhraseId === null ? '/api/phrases' : `/api/phrases/${editingPhraseId}`, {
      method: editingPhraseId === null ? 'POST' : 'PUT',
      body: JSON.stringify({ outcome: $('#phrase-outcome').value, body: $('#phrase-body').value })
    });
    resetPhraseForm();
    await loadPhrases();
    showToast('Frase guardada para las próximas imágenes.');
  } catch (error) { $('#phrase-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#phrase-cancel').addEventListener('click', resetPhraseForm);

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (loginInProgress) return;
  loginInProgress = true;
  loginError.textContent = '';
  const button = loginForm.querySelector('button[type="submit"]');
  button.textContent = 'Ingresando…';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ email: $('#email').value, password: $('#password').value }) });
    showApp();
    try { await loadGallery(); await loadPhrases(); }
    catch (error) {
      showToast(error.message);
      showApp();
    }
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    loginInProgress = false;
    button.textContent = 'Entrar';
  }
});

async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* always return to login */ }
  showLogin();
  loginForm.reset();
}
$('#logout-button').addEventListener('click', logout);
$('#logout-top').addEventListener('click', logout);

promptInput.addEventListener('input', () => { $('#char-count').textContent = String(promptInput.value.length); });

generateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  generateError.textContent = '';
  if (/\b(?:xauusd|trading|trade|operaci[oó]n(?:es)?|historial|ganancias?|p[eé]rdidas?)\b/i.test(promptInput.value)) {
    await openTemplatePreview();
    return;
  }
  const button = $('#generate-button');
  button.disabled = true;
  button.classList.add('loading');
  button.querySelector('span:nth-child(2)').textContent = 'Creando tu imagen…';
  try {
    const data = await api('/api/generate', { method: 'POST', body: JSON.stringify({ prompt: promptInput.value }) });
    promptInput.value = '';
    $('#char-count').textContent = '0';
    await loadGallery();
    $('#gallery').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast(`${data.image.name} ya está en tu galería.`);
  } catch (error) {
    generateError.textContent = error.message;
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
    button.querySelector('span:nth-child(2)').textContent = 'Generar imagen';
  }
});

async function openTemplatePreview() {
  generateError.textContent = '';
  const button = $('#template-button');
  button.disabled = true;
  button.textContent = 'Preparando vista previa…';
  try {
    const data = await api('/api/preview-template', { method: 'POST', body: JSON.stringify({ outcome: $('#template-outcome').value }) });
    previewToken = data.previewToken;
    $('#preview-layout').value = String(data.layoutVariant);
    $('#preview-address').value = data.preferredAddress || '';
    $('#preview-message').value = data.message;
    $('#preview-reply').value = data.reply;
    $('#preview-image').src = `${data.previewUrl}?v=${Date.now()}`;
    $('#template-preview-panel').classList.remove('hidden');
    $('#template-preview-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    generateError.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Crear con plantilla gratis';
  }
}

$('#template-button').addEventListener('click', openTemplatePreview);

$('#preview-refresh').addEventListener('click', async () => {
  if (!previewToken) return;
  const button = $('#preview-refresh');
  button.disabled = true;
  generateError.textContent = '';
  try {
    const data = await api('/api/preview-template', { method: 'POST', body: JSON.stringify({ previewToken, layoutVariant: Number($('#preview-layout').value), preferredAddress: $('#preview-address').value, message: $('#preview-message').value, reply: $('#preview-reply').value }) });
    $('#preview-message').value = data.message;
    $('#preview-image').src = `${data.previewUrl}?v=${Date.now()}`;
  } catch (error) { generateError.textContent = error.message; }
  finally { button.disabled = false; }
});

$('#preview-save').addEventListener('click', async () => {
  if (!previewToken) return;
  const button = $('#preview-save');
  button.disabled = true;
  generateError.textContent = '';
  try {
    await api('/api/preview-template', { method: 'POST', body: JSON.stringify({ previewToken, layoutVariant: Number($('#preview-layout').value), preferredAddress: $('#preview-address').value, message: $('#preview-message').value, reply: $('#preview-reply').value }) });
    const data = await api('/api/generate-template', { method: 'POST', body: JSON.stringify({ previewToken }) });
    previewToken = null;
    $('#template-preview-panel').classList.add('hidden');
    await loadGallery();
    $('#gallery').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast(`${data.image.name} ya está en tu galería. Sin uso de API.`);
  } catch (error) { generateError.textContent = error.message; }
  finally { button.disabled = false; }
});

$('#authentic-import-button').addEventListener('click', async () => {
  const file = $('#authentic-file').files?.[0];
  generateError.textContent = '';
  if (!file) { generateError.textContent = 'Selecciona una captura original.'; return; }
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 15 * 1024 * 1024) {
    generateError.textContent = 'Elige un PNG o JPEG de hasta 15 MB.';
    return;
  }
  const button = $('#authentic-import-button');
  button.disabled = true;
  try {
    const data = await api('/api/import-authentic', { method: 'POST', body: file, headers: { 'Content-Type': file.type } });
    $('#authentic-file').value = '';
    await loadGallery();
    $('#gallery').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast(`${data.image.name} ya está en tu galería.`);
  } catch (error) { generateError.textContent = error.message; }
  finally { button.disabled = false; }
});

$('#idea-button').addEventListener('click', () => {
  promptInput.value = 'Una conversación ficticia y divertida entre dos amigos que planean una gran aventura de fin de semana. Chat de iPhone en español, fondo verde suave, mensajes breves y expresivos, nombres aleatorios y una reacción alegre al final.';
  $('#char-count').textContent = String(promptInput.value.length);
  promptInput.focus();
});

$('#refresh-button').addEventListener('click', async () => {
  try { await loadGallery(); showToast('Galería actualizada.'); } catch (error) { showToast(error.message); }
});

$('#new-chat').addEventListener('click', () => {
  promptInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('#sidebar').classList.remove('open');
});

$('#mobile-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !appShell.classList.contains('hidden')) {
    event.preventDefault(); promptInput.focus();
  }
});

async function init() {
  try {
    const config = await api('/api/config');
    if (!config.configured) loginError.textContent = 'Configura LOGIN_EMAIL, LOGIN_PASSWORD y SESSION_SECRET en .env para habilitar el acceso.';
    $('#automatic-mode-label').textContent = config.automaticRenderMode === 'ai' ? 'con IA.' : 'con plantilla local, sin uso de API.';
    await api('/api/me');
    showApp();
    await loadGallery();
    await loadPhrases();
  } catch { showLogin(); }
}

init();
