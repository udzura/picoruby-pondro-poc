const element = id => document.getElementById(id);
let socket;
let totalTimer;
let activeCounterId;

async function counterValue(id, method = 'value') {
  const response = await fetch(`/api/Counter/${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method })
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()).value;
}

function updateTotal(value) {
  const current = Number(element('total-messages').value);
  element('total-messages').value = Math.max(Number.isFinite(current) ? current : 0, value);
}

async function refreshTotal(connection, counterId) {
  try {
    const value = await counterValue(counterId);
    if (socket === connection && socket.readyState === WebSocket.OPEN && activeCounterId === counterId) updateTotal(value);
  } catch (error) { console.error('Failed to refresh total messages', error); }
}

async function counter(method) {
  const id = element('counter-id').value.trim();
  if (!id) { element('counter-status').textContent = 'Enter a counter ID'; return; }
  try {
    element('count').textContent = await counterValue(id, method);
    element('counter-status').textContent = 'State saved in Durable Object storage';
  } catch (error) { element('counter-status').textContent = error.message; }
}
element('read').onclick = () => counter('value');
element('increment').onclick = () => counter('increment');

function appendText(text) {
  const item = document.createElement('li');
  item.textContent = text;
  element('messages').append(item);
  while (element('messages').children.length > 50) element('messages').firstChild.remove();
  item.scrollIntoView({ block: 'nearest' });
}

function append(entry) {
  appendText(`#${entry.sequence} · ${entry.sender.slice(0, 8)}: ${entry.text}`);
}

element('connect').onclick = () => {
  const id = element('room-id').value.trim();
  const counterId = element('chat-counter-id').value.trim();
  if (!id) { element('socket-status').textContent = 'Enter a room ID'; return; }
  if (!counterId) { element('socket-status').textContent = 'Enter a counter ID'; return; }
  const url = new URL(`/ws/ChatRoom/${encodeURIComponent(id)}`, location.href);
  url.searchParams.set('counter_id', counterId);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(url);
  const connection = socket;
  clearInterval(totalTimer);
  activeCounterId = null;
  element('total-messages').value = '—';
  element('connect').disabled = true;
  element('room-id').disabled = true;
  element('chat-counter-id').disabled = true;
  element('socket-status').textContent = 'Connecting…';
  socket.onopen = () => {
    element('socket-status').textContent = 'Connected';
    element('disconnect').disabled = false;
  };
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === 'welcome') {
      element('messages').replaceChildren();
      event.history.forEach(append);
      activeCounterId = event.counter_id;
      element('chat-counter-id').value = event.counter_id;
      updateTotal(event.count);
      element('send').disabled = false;
      totalTimer = setInterval(() => refreshTotal(connection, event.counter_id), 3000);
    } else if (event.type === 'message') {
      append(event.entry);
      if (event.counter_id === activeCounterId) updateTotal(event.count);
    }
    else if (event.type === 'left') appendText(`${event.id.slice(0, 8)} left the room`);
  };
  socket.onerror = () => { element('socket-status').textContent = 'Connection error'; };
  socket.onclose = event => {
    clearInterval(totalTimer);
    element('socket-status').textContent = `Disconnected (${event.code}) ${event.reason}`;
    element('connect').disabled = false;
    element('room-id').disabled = false;
    element('chat-counter-id').disabled = false;
    element('send').disabled = true;
    element('disconnect').disabled = true;
  };
};
element('disconnect').onclick = () => socket?.close(1000, 'Leaving room');
element('message-form').onsubmit = event => {
  event.preventDefault();
  if (socket?.readyState !== WebSocket.OPEN) return;
  const message = element('message').value;
  if (new TextEncoder().encode(message).length > 4096) {
    element('socket-status').textContent = 'Message exceeds 4096 bytes'; return;
  }
  socket.send(message);
  element('message').value = '';
};
