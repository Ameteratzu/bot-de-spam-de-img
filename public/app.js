const $ = (selector) => document.querySelector(selector);
let quantity = 10;
let pollTimer = null;
let lastCompleted = -1;
let toastTimer;
let selectionMode = false;
const selectedIds = new Set();

async function api(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      credentials: 'same-origin', signal: controller.signal, ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : {};
    if (!response.ok) {
      if (response.status === 401 && url !== '/api/login') showLogin();
      throw new Error(payload.error || 'No se pudo completar la solicitud.');
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('El servidor tardó demasiado en responder.');
    throw error;
  } finally { clearTimeout(timeout); }
}

function showLogin() { $('#app-shell').classList.add('hidden'); $('#login-screen').classList.remove('hidden'); stopPolling(); }
function showApp() { $('#login-screen').classList.add('hidden'); $('#app-shell').classList.remove('hidden'); }
function showToast(message) { const el=$('#toast'); el.textContent=message; el.classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('visible'),3000); }
function stopPolling(){ if(pollTimer){clearTimeout(pollTimer);pollTimer=null;} }
function formatTime(value){ return new Intl.DateTimeFormat('es-PE',{hour:'numeric',minute:'2-digit'}).format(new Date(value)); }
function formatDay(key){ const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); if(key===today)return 'Hoy'; const d=new Date(`${key}T12:00:00`); return new Intl.DateTimeFormat('es-PE',{weekday:'long',day:'numeric',month:'long'}).format(d).replace(/^./,c=>c.toUpperCase()); }
function updateQuantity(next){ quantity=Math.max(1,Math.min(50,next)); $('#quantity-value').textContent=String(quantity); $('#quantity-minus').disabled=quantity===1; $('#quantity-plus').disabled=quantity===50; }

function updateSelectionUI(){
  const count=selectedIds.size;
  $('#selection-count').textContent=`${count} ${count===1?'seleccionada':'seleccionadas'}`;
  $('#delete-selected').disabled=count===0;
  document.querySelectorAll('.image-card').forEach(card=>{
    const selected=selectedIds.has(card.dataset.imageId);
    card.classList.toggle('selected',selected);
    card.querySelector('.selection-check')?.setAttribute('aria-checked',String(selected));
  });
}
function setSelectionMode(enabled){
  selectionMode=enabled; document.body.classList.toggle('selection-mode',enabled); $('#selection-bar').classList.toggle('hidden',!enabled); $('#select-button').textContent=enabled?'Seleccionando':'Seleccionar';
  if(!enabled)selectedIds.clear(); updateSelectionUI();
}
function toggleSelected(id){ selectedIds.has(id)?selectedIds.delete(id):selectedIds.add(id); updateSelectionUI(); }

function openViewer(image){ $('#viewer-image').src=image.url; $('#viewer-image').alt=`Imagen de chat de ${image.name}`; $('#viewer-download').href=image.downloadUrl; $('#viewer').showModal(); }
function renderGallery(data){
  const host=$('#gallery-groups'); host.replaceChildren();
  for(const group of data.groups){
    const section=document.createElement('section'); section.className='day-group';
    const heading=document.createElement('div'); heading.className='day-heading';
    const title=document.createElement('h3'); title.textContent=formatDay(group.dayKey);
    const actions=document.createElement('div'); actions.className='day-heading-actions';
    const count=document.createElement('span'); count.textContent=`${group.images.length} ${group.images.length===1?'imagen':'imágenes'}`;
    const selectDay=document.createElement('button'); selectDay.type='button'; selectDay.className='select-day'; selectDay.textContent='Seleccionar día';
    selectDay.addEventListener('click',()=>{const allSelected=group.images.every(image=>selectedIds.has(image.id));for(const image of group.images){allSelected?selectedIds.delete(image.id):selectedIds.add(image.id);}updateSelectionUI();selectDay.textContent=allSelected?'Seleccionar día':'Quitar día';});
    actions.append(count,selectDay); heading.append(title,actions);
    const grid=document.createElement('div'); grid.className='gallery-grid';
    for(const image of group.images){
      const card=$('#image-card-template').content.firstElementChild.cloneNode(true);
      card.dataset.imageId=image.id;
      const img=card.querySelector('img'); img.src=image.url; img.alt=`Imagen de chat de ${image.name}`;
      card.querySelector('strong').textContent=image.name; card.querySelector('.image-card-footer span').textContent=formatTime(image.createdAt);
      card.querySelector('.download').href=image.downloadUrl;
      card.querySelector('.image-open').addEventListener('click',()=>selectionMode?toggleSelected(image.id):openViewer(image));
      card.querySelector('.selection-check').addEventListener('click',()=>{
        if(!selectionMode)setSelectionMode(true);
        toggleSelected(image.id);
      });
      card.classList.toggle('selected',selectedIds.has(image.id));
      grid.append(card);
    }
    section.append(heading,grid); host.append(section);
  }
  $('#empty-state').classList.toggle('hidden',data.total>0);
}
async function loadGallery(){ const data=await api('/api/images'); renderGallery(data); return data; }

function renderJob(job){
  const panel=$('#job-panel');
  if(!job){ panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const done=job.status==='completed'; const failed=job.status==='failed';
  $('#job-kicker').textContent=job.kind==='automatic'?'Generación diaria':'Generación adicional';
  $('#job-title').textContent=done?'Tus imágenes están listas':failed?'La generación se detuvo':job.status==='pending'?'En espera para comenzar':'Creando tus imágenes';
  $('#job-count').textContent=`${job.completed}/${job.quantity}`;
  $('#job-progress').style.width=`${Math.round(job.completed/job.quantity*100)}%`;
  $('#job-message').textContent=failed?(job.error||'No se pudo completar el trabajo.'):(done?'Ya puedes descargarlas desde la galería.':'Puedes cerrar esta página; el trabajo continuará.');
}
async function pollJobs(){
  stopPolling();
  try{
    const data=await api('/api/generation-jobs');
    const active=data.jobs.find(job=>job.status==='running'||job.status==='pending');
    const latest=active||data.jobs[0]||null;
    renderJob(latest);
    if(latest&&latest.completed!==lastCompleted){ lastCompleted=latest.completed; await loadGallery(); }
    if(active){ pollTimer=setTimeout(pollJobs,1800); }
    else if(latest?.status==='completed'){ await loadGallery(); }
  }catch(error){ showToast(error.message); pollTimer=setTimeout(pollJobs,5000); }
}

async function loadPhrases(){
  const {phrases}=await api('/api/phrases'); const host=$('#phrase-list'); host.replaceChildren();
  for(const phrase of phrases){
    const item=document.createElement('article'); item.className='phrase-item';
    const content=document.createElement('div'); const tag=document.createElement('span'); tag.className='phrase-tag'; tag.textContent=phrase.outcome==='gain'?'GANANCIA':'PÉRDIDA';
    const body=document.createElement('p'); body.textContent=phrase.body; content.append(tag,body);
    const remove=document.createElement('button'); remove.type='button'; remove.textContent='×'; remove.setAttribute('aria-label','Eliminar frase');
    remove.addEventListener('click',async()=>{ remove.disabled=true; try{await api(`/api/phrases/${phrase.id}`,{method:'DELETE'}); await loadPhrases(); showToast('Frase eliminada.');}catch(error){showToast(error.message);remove.disabled=false;} });
    item.append(content,remove); host.append(item);
  }
}

$('#quantity-minus').addEventListener('click',()=>updateQuantity(quantity-1));
$('#quantity-plus').addEventListener('click',()=>updateQuantity(quantity+1));
$('#generate-form').addEventListener('submit',async(event)=>{
  event.preventDefault(); const button=$('#generate-button'); $('#generate-error').textContent=''; button.disabled=true; button.textContent='Agregando a la cola…';
  try{ const {job}=await api('/api/generation-jobs',{method:'POST',body:JSON.stringify({quantity})}); lastCompleted=-1; renderJob(job); pollJobs(); $('#job-panel').scrollIntoView({behavior:'smooth',block:'center'}); showToast(`Generación de ${quantity} imágenes iniciada.`); }
  catch(error){ $('#generate-error').textContent=error.message; }
  finally{ button.disabled=false; button.textContent='Generar imágenes'; }
});

$('#phrase-body').addEventListener('input',()=>$('#phrase-counter').textContent=`${$('#phrase-body').value.length}/260`);
$('#phrase-form').addEventListener('submit',async(event)=>{
  event.preventDefault(); const button=$('#phrase-save'); $('#phrase-error').textContent=''; button.disabled=true;
  try{ await api('/api/phrases',{method:'POST',body:JSON.stringify({outcome:$('#phrase-outcome').value,body:$('#phrase-body').value})}); $('#phrase-body').value=''; $('#phrase-counter').textContent='0/260'; await loadPhrases(); showToast('Frase agregada a tu cuenta.'); }
  catch(error){ $('#phrase-error').textContent=error.message; }
  finally{ button.disabled=false; }
});

$('#login-form').addEventListener('submit',async(event)=>{
  event.preventDefault(); const button=event.currentTarget.querySelector('button'); $('#login-error').textContent=''; button.disabled=true; button.textContent='Ingresando…';
  try{ await api('/api/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value})}); await bootApp(); }
  catch(error){ $('#login-error').textContent=error.message; }
  finally{ button.disabled=false; button.textContent='Entrar'; }
});
async function logout(){ try{await api('/api/logout',{method:'POST'});}catch{} $('#login-form').reset(); showLogin(); }
$('#logout-button').addEventListener('click',logout);
$('#refresh-button').addEventListener('click',async()=>{try{await Promise.all([loadGallery(),loadPhrases()]);showToast('Contenido actualizado.');}catch(error){showToast(error.message);}});
$('#select-button').addEventListener('click',()=>setSelectionMode(!selectionMode));
$('#selection-cancel').addEventListener('click',()=>setSelectionMode(false));
$('#delete-selected').addEventListener('click',async()=>{
  const ids=[...selectedIds];
  if(!ids.length||!window.confirm(`¿Eliminar ${ids.length} ${ids.length===1?'imagen':'imágenes'}? Esta acción no se puede deshacer.`))return;
  const button=$('#delete-selected'); button.disabled=true; button.textContent='Eliminando…';
  try{const result=await api('/api/images',{method:'DELETE',body:JSON.stringify({ids})});setSelectionMode(false);await loadGallery();showToast(`${result.deleted} ${result.deleted===1?'imagen eliminada':'imágenes eliminadas'}.`);}
  catch(error){showToast(error.message);button.disabled=false;}
  finally{button.textContent='Eliminar';}
});
$('#viewer-close').addEventListener('click',()=>$('#viewer').close());
$('#viewer').addEventListener('click',(event)=>{if(event.target===$('#viewer'))$('#viewer').close();});

async function bootApp(){
  const me=await api('/api/me'); $('#account-email').textContent=me.email; const name=me.email.split('@')[0]; $('#account-name').textContent=name.charAt(0).toUpperCase()+name.slice(1); $('#account-avatar').textContent=name.charAt(0).toUpperCase(); showApp(); await Promise.all([loadGallery(),loadPhrases()]); await pollJobs();
}
async function init(){ updateQuantity(10); try{const config=await api('/api/config');if(!config.configured)$('#login-error').textContent='Falta completar la configuración del servidor.';await bootApp();}catch{showLogin();}}
init();
