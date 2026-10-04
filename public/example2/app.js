import { t, localize, applyLanguage, setLanguage } from './i18n.js';

const $ = id => document.getElementById(id);
const admin = new URLSearchParams(location.search).get('admin') === '1';
const encoder = new TextEncoder();
const entries = new Map();
const active = new Set();
let socket;
let self;
let loadedAI;
let loadingAI = false;
let loadingCatalog = false;

function connected() { return socket?.readyState === WebSocket.OPEN; }
function controls() {
  const open = connected();
  $('connect').disabled = !!socket;
  $('disconnect').disabled = !socket;
  $('room-id').disabled = !!socket;
  $('human-name').disabled = !!socket;
  $('message').disabled = !open || active.size > 0;
  $('send').disabled = !open || active.size > 0;
  $('ai-settings').disabled = !admin;
  $('invite').disabled = !admin || !open || !loadedAI || active.size > 0 || loadingAI;
  $('create-ai').disabled = !admin || loadingAI || loadingCatalog;
  $('refresh-ai').disabled = !admin || loadingAI || loadingCatalog;
  $('existing-ai').disabled = !admin || loadingAI || loadingCatalog || $('existing-ai').options.length <= 1;
  for (const button of $('participants').querySelectorAll('button')) button.disabled = !open || active.size > 0;
}

function element(tag, className, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function plain(node, value = '') {
  delete node.dataset.i18n;
  delete node.dataset.i18nParams;
  node.textContent = value;
}

function translated(tag, className, key, params) {
  return localize(element(tag, className), key, params);
}

function scroll() { $('timeline').scrollTop = $('timeline').scrollHeight; }
function clearEmpty() { $('empty')?.remove(); }
function render(entry, pending = false) {
  clearEmpty();
  let item = entries.get(entry.sequence);
  if (!item) {
    const node = element('article', 'message');
    const sender = element('div', 'sender');
    sender.dataset.replying = t('replying'); sender.dataset.interrupted = t('interrupted');
    const bubble = element('div', 'bubble');
    node.append(sender, bubble);
    $('timeline').append(node);
    item = { node, sender, bubble };
    entries.set(entry.sequence, item);
  }
  item.node.className = `message ${entry.sender.kind === 'ai' ? 'ai' : ''} ${entry.sender.id === self ? 'own' : ''} ${pending ? 'pending' : ''}`;
  item.sender.textContent = `${entry.sender.name}${entry.sender.kind === 'ai' ? ' · AI' : ''}`;
  if (!entry.text && pending) localize(item.bubble, 'thinking');
  else plain(item.bubble, entry.text || '');
  item.text = entry.text;
  scroll();
}

function participants(list) {
  $('participants').replaceChildren();
  if (!list.length) $('participants').append(translated('span', 'hint', admin ? 'noAI' : 'noAIGuest'));
  for (const ai of list) {
    const chip = element('span', 'participant');
    const label = element('span', '', `✳ ${ai.name} · ${ai.id}`);
    const remove = translated('button', 'remove-ai', 'remove', { name: ai.name });
    remove.type = 'button';
    remove.dataset.i18nAria = 'removeLabel';
    remove.setAttribute('aria-label', t('removeLabel', { name: ai.name }));
    remove.addEventListener('click', () => {
      if (connected() && !active.size) socket.send(JSON.stringify({ type: 'remove', ai_id: ai.id }));
    });
    chip.append(label, remove);
    $('participants').append(chip);
  }
}

function receive(event) {
  switch (event.type) {
    case 'welcome':
      self = event.self;
      entries.clear(); active.clear(); $('timeline').replaceChildren();
      plain($('room-title'), event.room);
      localize($('mode'), event.ai_mode === 'mock' ? 'mock' : 'live');
      participants(event.participants);
      for (const entry of event.history) render(entry);
      plain($('chat-status'));
      break;
    case 'participants': participants(event.participants); break;
    case 'message': render(event.entry); active.delete(event.entry.sequence); break;
    case 'ai_start': active.add(event.entry.sequence); render(event.entry, true); break;
    case 'ai_delta': {
      const item = entries.get(event.sequence);
      if (item) { item.text += event.delta; plain(item.bubble, item.text); scroll(); }
      break;
    }
    case 'ai_error': {
      active.delete(event.sequence);
      const item = entries.get(event.sequence);
      if (item) { item.node.classList.remove('pending'); item.node.classList.add('failed'); }
      localize($('chat-status'), 'aiError', { detail: event.text });
      break;
    }
    case 'ready': active.clear(); break;
    case 'notice': {
      clearEmpty();
      const departure = event.text.match(/^([\s\S]*) left the room\.$/);
      if (event.action === 'join' && event.participant) {
        $('timeline').append(translated('p', 'notice', event.participant.kind === 'ai' ? 'aiJoinedRoom' : 'humanJoinedRoom', { name: event.participant.name }));
      } else {
        $('timeline').append(departure ? translated('p', 'notice', 'departed', { name: departure[1] }) : element('p', 'notice', event.text));
      }
      scroll(); break;
    }
    case 'error': localize($('chat-status'), 'error', { detail: event.text }); break;
  }
  controls();
}

$('connect-form').addEventListener('submit', event => {
  event.preventDefault();
  if (socket) return;
  const room = $('room-id').value.trim();
  const name = $('human-name').value.trim();
  if (!room || !name || encoder.encode(name).length > 128) { localize($('chat-status'), 'invalidConnection'); return; }
  const url = new URL(`/ws/AIChatRoom/${encodeURIComponent(room)}`, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('name', name);
  const connection = new WebSocket(url);
  socket = connection;
  localize($('connection'), 'connecting');
  controls();
  connection.addEventListener('open', () => {
    if (socket !== connection) return;
    localize($('connection'), 'connected'); $('connection').classList.add('connected'); controls();
  });
  connection.addEventListener('message', event => {
    if (socket !== connection) return;
    try { receive(JSON.parse(event.data)); } catch { localize($('chat-status'), 'unreadable'); }
  });
  connection.addEventListener('close', () => {
    if (socket !== connection) return;
    socket = null;
    for (const sequence of active) { const item = entries.get(sequence); item?.node.classList.replace('pending', 'failed'); }
    active.clear();
    localize($('connection'), 'disconnected'); $('connection').classList.remove('connected'); controls();
  });
  connection.addEventListener('error', () => { if (socket === connection) localize($('chat-status'), 'connectionFailed'); });
});
$('disconnect').addEventListener('click', () => socket?.close(1000, 'Leaving room'));

async function rpc(id, method, args = [], klass = 'AIParticipant') {
  const response = await fetch(`/api/${klass}/${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args })
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()).value;
}

async function refreshCatalog() {
  if (!admin || loadingCatalog) return;
  loadingCatalog = true; controls();
  localize($('catalog-info'), 'loadingCatalog');
  try {
    const list = await rpc('default', 'list', [], 'AICatalog');
    const placeholder = translated('option', '', 'chooseAI');
    placeholder.value = '';
    $('existing-ai').replaceChildren(placeholder);
    for (const ai of list) {
      const option = element('option', '', `${ai.name} · ${ai.id}`);
      option.value = ai.id;
      $('existing-ai').append(option);
    }
    $('existing-ai').value = loadedAI?.id || '';
    localize($('catalog-info'), list.length ? 'catalogCount' : 'emptyCatalog', { count: list.length });
  } catch (error) { localize($('catalog-info'), 'error', { detail: error.message }); }
  finally { loadingCatalog = false; controls(); }
}

async function loadAI(id, create = false) {
  if (!admin || loadingAI) return;
  const name = $('ai-name').value.trim();
  const prompt = $('personality').value.trim();
  if (create && (encoder.encode(name).length > 128 || encoder.encode(prompt).length > 4096)) {
    localize($('ai-info'), 'invalidPersona'); return;
  }
  loadedAI = null;
  loadingAI = true; controls();
  localize($('ai-info'), 'loadingAI');
  try {
    let profile = await rpc(id, 'load');
    const existing = !!profile;
    if (!profile && create) profile = (await rpc(id, 'configure', [name, prompt])).profile;
    if ($('ai-id').value.trim() !== id) return;
    if (!profile) { localize($('ai-info'), 'missingAI'); return; }
    loadedAI = profile;
    $('ai-name').value = profile.name; $('personality').value = profile.prompt;
    $('ai-name').readOnly = true; $('personality').readOnly = true;
    plain($('ai-info'));
    $('ai-info').append(translated('span', '', existing ? 'loaded' : 'saved'), ' ',
      translated('span', '', profile.rooms.length ? 'rooms' : 'readyToJoin', { rooms: profile.rooms.join(', ') }), ' ',
      translated('span', '', 'reuse'));
    await refreshCatalog();
  } catch (error) { localize($('ai-info'), 'error', { detail: error.message }); }
  finally { loadingAI = false; controls(); }
}

$('ai-id').addEventListener('input', () => {
  loadedAI = null; $('existing-ai').value = ''; $('ai-name').readOnly = false; $('personality').readOnly = false; controls();
});
$('refresh-ai').addEventListener('click', refreshCatalog);
$('existing-ai').addEventListener('change', () => {
  const id = $('existing-ai').value;
  if (!admin || !id) return;
  $('ai-id').value = id;
  loadAI(id);
});
$('ai-form').addEventListener('submit', event => {
  event.preventDefault();
  loadAI($('ai-id').value.trim(), true);
});
$('invite').addEventListener('click', () => {
  if (admin && connected() && loadedAI && !active.size && !loadingAI) socket.send(JSON.stringify({ type: 'invite', ai_id: loadedAI.id }));
});
$('message-form').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('message').value.trim();
  if (!connected() || active.size || !text) return;
  if (encoder.encode(text).length > 2000) { localize($('chat-status'), 'messageTooLong'); return; }
  const frame = JSON.stringify({ type: 'say', text });
  if (encoder.encode(frame).length > 4096) { localize($('chat-status'), 'frameTooLong'); return; }
  socket.send(frame); $('message').value = ''; plain($('chat-status'));
});
$('message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('message-form').requestSubmit(); }
});
$('admin-info').hidden = admin;
if (!admin) {
  $('empty').querySelector('p').dataset.i18n = 'emptyGuest';
  $('participants').querySelector('span').dataset.i18n = 'noAIGuest';
}
$('language').addEventListener('change', event => setLanguage(event.target.value));
applyLanguage();
controls();
if (admin) refreshCatalog();
