const $ = id => document.getElementById(id);
const encoder = new TextEncoder();
const entries = new Map();
const active = new Set();
let socket;
let self;
let loadedAI;
let loadingAI = false;

function connected() { return socket?.readyState === WebSocket.OPEN; }
function controls() {
  const open = connected();
  $('connect').disabled = !!socket;
  $('disconnect').disabled = !socket;
  $('room-id').disabled = !!socket;
  $('human-name').disabled = !!socket;
  $('message').disabled = !open || active.size > 0;
  $('send').disabled = !open || active.size > 0;
  $('invite').disabled = !open || !loadedAI || active.size > 0 || loadingAI;
  $('create-ai').disabled = loadingAI;
  for (const button of $('participants').querySelectorAll('button')) button.disabled = !open || active.size > 0;
}

function element(tag, className, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function scroll() { $('timeline').scrollTop = $('timeline').scrollHeight; }
function clearEmpty() { $('empty')?.remove(); }
function render(entry, pending = false) {
  clearEmpty();
  let item = entries.get(entry.sequence);
  if (!item) {
    const node = element('article', 'message');
    const sender = element('div', 'sender');
    const bubble = element('div', 'bubble');
    node.append(sender, bubble);
    $('timeline').append(node);
    item = { node, sender, bubble };
    entries.set(entry.sequence, item);
  }
  item.node.className = `message ${entry.sender.kind === 'ai' ? 'ai' : ''} ${entry.sender.id === self ? 'own' : ''} ${pending ? 'pending' : ''}`;
  item.sender.textContent = `${entry.sender.name}${entry.sender.kind === 'ai' ? ' · AI' : ''}`;
  item.bubble.textContent = entry.text || (pending ? 'Thinking…' : '');
  item.text = entry.text;
  scroll();
}

function participants(list) {
  $('participants').replaceChildren();
  if (!list.length) $('participants').append(element('span', 'hint', 'No AI participants yet. Invite one from the left.'));
  for (const ai of list) {
    const chip = element('span', 'participant');
    const label = element('span', '', `✳ ${ai.name} · ${ai.id}`);
    const remove = element('button', 'remove-ai', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${ai.name} from this room`);
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
      $('room-title').textContent = event.room;
      $('mode').textContent = event.ai_mode === 'mock' ? 'Local demo · mock AI' : 'Workers AI';
      participants(event.participants);
      for (const entry of event.history) render(entry);
      if (!event.history.length) $('timeline').append(element('p', 'notice', 'You joined the room. Say hello or invite an AI.'));
      $('chat-status').textContent = '';
      break;
    case 'participants': participants(event.participants); break;
    case 'message': render(event.entry); active.delete(event.entry.sequence); break;
    case 'ai_start': active.add(event.entry.sequence); render(event.entry, true); break;
    case 'ai_delta': {
      const item = entries.get(event.sequence);
      if (item) { item.text += event.delta; item.bubble.textContent = item.text; scroll(); }
      break;
    }
    case 'ai_error': {
      active.delete(event.sequence);
      const item = entries.get(event.sequence);
      if (item) { item.node.classList.remove('pending'); item.node.classList.add('failed'); }
      $('chat-status').textContent = event.text;
      break;
    }
    case 'ready': active.clear(); break;
    case 'notice': clearEmpty(); $('timeline').append(element('p', 'notice', event.text)); scroll(); break;
    case 'error': $('chat-status').textContent = event.text; break;
  }
  controls();
}

$('connect-form').addEventListener('submit', event => {
  event.preventDefault();
  if (socket) return;
  const room = $('room-id').value.trim();
  const name = $('human-name').value.trim();
  if (!room || !name || encoder.encode(name).length > 128) { $('chat-status').textContent = 'Enter a Room ID and a name of at most 128 bytes.'; return; }
  const url = new URL(`/ws/AIChatRoom/${encodeURIComponent(room)}`, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('name', name);
  const connection = new WebSocket(url);
  socket = connection;
  $('connection').textContent = 'Connecting…';
  controls();
  connection.addEventListener('open', () => {
    if (socket !== connection) return;
    $('connection').textContent = 'Connected'; $('connection').classList.add('connected'); controls();
  });
  connection.addEventListener('message', event => {
    if (socket !== connection) return;
    try { receive(JSON.parse(event.data)); } catch { $('chat-status').textContent = 'Could not read a server message.'; }
  });
  connection.addEventListener('close', () => {
    if (socket !== connection) return;
    socket = null;
    for (const sequence of active) { const item = entries.get(sequence); item?.node.classList.replace('pending', 'failed'); }
    active.clear();
    $('connection').textContent = 'Disconnected'; $('connection').classList.remove('connected'); controls();
  });
  connection.addEventListener('error', () => { if (socket === connection) $('chat-status').textContent = 'Connection failed. Check that the example2 server is running.'; });
});
$('disconnect').addEventListener('click', () => socket?.close(1000, 'Leaving room'));

async function rpc(id, method, args = []) {
  const response = await fetch(`/api/AIParticipant/${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args })
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()).value;
}

$('ai-id').addEventListener('input', () => {
  loadedAI = null; $('ai-name').readOnly = false; $('personality').readOnly = false; controls();
});
$('ai-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = $('ai-id').value.trim();
  const name = $('ai-name').value.trim();
  const prompt = $('personality').value.trim();
  if (encoder.encode(name).length > 128 || encoder.encode(prompt).length > 4096) { $('ai-info').textContent = 'Name: at most 128 bytes. Prompt: at most 4096 bytes.'; return; }
  loadingAI = true; controls();
  try {
    let profile = await rpc(id, 'profile');
    const existing = !!profile;
    if (!profile) profile = (await rpc(id, 'configure', [name, prompt])).profile;
    if ($('ai-id').value.trim() !== id) return;
    loadedAI = profile;
    $('ai-name').value = profile.name; $('personality').value = profile.prompt;
    $('ai-name').readOnly = true; $('personality').readOnly = true;
    $('ai-info').textContent = `${existing ? 'Loaded the saved personality.' : 'Personality saved.'} ${profile.rooms.length ? `Rooms: ${profile.rooms.join(', ')}.` : 'Ready to join a room.'} Reuse this AI ID in another room.`;
  } catch (error) { $('ai-info').textContent = error.message; }
  finally { loadingAI = false; controls(); }
});
$('invite').addEventListener('click', () => {
  if (connected() && loadedAI) socket.send(JSON.stringify({ type: 'invite', ai_id: loadedAI.id }));
});
$('message-form').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('message').value.trim();
  if (!connected() || active.size || !text) return;
  if (encoder.encode(text).length > 2000) { $('chat-status').textContent = 'Message must be at most 2000 bytes.'; return; }
  const frame = JSON.stringify({ type: 'say', text });
  if (encoder.encode(frame).length > 4096) { $('chat-status').textContent = 'Encoded message is too large. Please shorten it.'; return; }
  socket.send(frame); $('message').value = ''; $('chat-status').textContent = '';
});
$('message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('message-form').requestSubmit(); }
});
controls();
