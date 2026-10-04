import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const temporary = await mkdtemp(join(tmpdir(), 'pondro-e2e-'));
const server = createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const base = `http://127.0.0.1:${port}`;
let process;
let logs = '';
const sockets = [];
const auth = 'Basic ' + Buffer.from('e2e-user:e2e-password').toString('base64');
function authenticatedFetch(url, options = {}) {
  return fetch(url, { ...options, headers: { ...options.headers, Authorization: auth } });
}


async function seedR2() {
  const file = join(temporary, 'stream.txt');
  await writeFile(file, '日本語\n\nfinal');
  const child = spawn(globalThis.process.execPath, ['node_modules/wrangler/bin/wrangler.js',
    'r2', 'object', 'put', 'pondro-stream-demo/sample', '--local', '--persist-to', join(temporary, 'state'), '--file', file], {
    env: { ...globalThis.process.env, WRANGLER_SEND_METRICS: 'false',
      XDG_CONFIG_HOME: join(temporary, 'config'), XDG_CACHE_HOME: join(temporary, 'cache') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
}

async function start() {
  logs = '';
  process = spawn(globalThis.process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev',
    '--port', String(port), '--inspector-port', '0', '--persist-to', join(temporary, 'state'),
    '--var', 'BASIC_AUTH_USER:e2e-user', '--var', 'BASIC_AUTH_PASSWORD:e2e-password'], {
    env: { ...globalThis.process.env, WRANGLER_SEND_METRICS: 'false',
      XDG_CONFIG_HOME: join(temporary, 'config'), XDG_CACHE_HOME: join(temporary, 'cache') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  process.stdout.on('data', data => { logs += data; });
  process.stderr.on('data', data => { logs += data; });
  for (let i = 0; i < 150; i++) {
    if (process.exitCode !== null) throw new Error(logs);
    try { if ((await authenticatedFetch(base, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await delay(200);
  }
  throw new Error(`Wrangler startup timed out: ${logs}`);
}

async function stop() {
  if (!process || process.exitCode !== null) return;
  const exited = once(process, 'exit');
  process.kill('SIGTERM');
  const timer = setTimeout(() => process.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function rpc(klass, id, method, args = []) {
  const response = await authenticatedFetch(`${base}/api/${klass}/${id}`, {
    method: 'POST', body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(5000)
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).value;
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', receive); reject(new Error('WebSocket message timeout')); }, 5000);
    const receive = message => { clearTimeout(timeout); resolve(JSON.parse(message.toString())); };
    socket.once('message', receive);
  });
}

async function connect(room, counter = room) {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws/ChatRoom/${room}?counter_id=${encodeURIComponent(counter)}`, { headers: { Authorization: auth } });
  sockets.push(socket);
  const welcome = nextMessage(socket);
  await once(socket, 'open');
  return { socket, welcome: await welcome };
}

try {
  await seedR2();
  await start();
  assert.deepEqual(await rpc('StreamProbe', 'read', 'read_object', ['sample', 'read_all']), [...new TextEncoder().encode('日本語\n\nfinal')]);
  assert.deepEqual(await rpc('StreamProbe', 'read', 'read_object', ['sample', 'readline']), [...new TextEncoder().encode('日本語\n')]);
  assert.equal(await rpc('StreamProbe', 'read', 'read_object', ['missing']), null);
  const live = new WebSocket(`${base.replace('http:', 'ws:')}/ws/StreamProbe/live`, { headers: { Authorization: auth } });
  sockets.push(live);
  const ready = nextMessage(live);
  await once(live, 'open');
  assert.equal((await ready).type, 'ready');
  const streamed = [];
  const done = new Promise(resolve => { live.on('message', message => {
    const event = JSON.parse(message.toString());
    streamed.push(event);
    if (event.type === 'done') resolve();
  }); });
  live.send('sample');
  await done;
  assert.deepEqual(streamed, [{ type: 'line', text: '日本語\n' }, { type: 'line', text: '\n' }, { type: 'line', text: 'final' }, { type: 'done' }]);
  assert.match(await (await authenticatedFetch(base)).text(), /PONDRO playground/);
  const note = { kv: "日本語 and 'bound SQL'", d1: "日本語 and 'bound SQL'" };
  assert.deepEqual(await rpc('BindingProbe', 'note', 'store_note', [note.kv]), note);
  assert.deepEqual(await rpc('BindingProbe', 'note', 'read_note'), note);
  assert.equal(await rpc('Counter', 'one', 'value'), 0);
  const values = await Promise.all(Array.from({ length: 12 }, () => rpc('Counter', 'one', 'increment')));
  assert.deepEqual(values.sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(await rpc('Counter', 'two', 'value'), 0);
  const [a, b, other] = await Promise.all([connect('lobby', 'speech-total'), connect('lobby', 'speech-total'), connect('other', 'other-total')]);
  assert.equal(a.welcome.type, 'welcome');
  assert.equal(a.welcome.counter_id, 'speech-total');
  assert.equal(a.welcome.count, 0);
  let otherReceived = false;
  other.socket.on('message', () => { otherReceived = true; });
  const messages = [nextMessage(a.socket), nextMessage(b.socket)];
  a.socket.send('こんにちは 🌊');
  for (const message of await Promise.all(messages)) {
    assert.equal(message.entry.text, 'こんにちは 🌊');
    assert.equal(message.entry.count, 1);
    assert.equal(message.count, 1);
    assert.equal(message.counter_id, 'speech-total');
  }
  assert.equal(await rpc('Counter', 'speech-total', 'value'), 1);
  assert.equal(await rpc('Counter', 'lobby', 'value'), 0);
  assert.equal(await rpc('Counter', 'other-total', 'value'), 0);
  assert.equal((await authenticatedFetch(`${base}/api/ChatRoom/lobby`, { method: 'POST', body: '{"method":"history","http":true,"type":"rpc"}' })).status, 403);
  assert.equal(other.welcome.history.length, 0);
  assert.equal(otherReceived, false);
  const departure = nextMessage(a.socket);
  const departingClosed = once(b.socket, 'close');
  b.socket.close(1000, 'Leaving room');
  await departingClosed;
  const notice = await departure;
  assert.equal(notice.type, 'left');
  assert.equal(typeof notice.id, 'string');
  assert.notEqual(notice.id, (await messages[0]).entry.sender);
  assert.equal(await rpc('Counter', 'speech-total', 'value'), 1);
  assert.equal(otherReceived, false);
  const forbidden = await authenticatedFetch(`${base}/api/Counter/one`, { method: 'POST', body: '{"method":"send"}' });
  assert.equal(forbidden.status, 403);
  assert.equal((await authenticatedFetch(`${base}/ws/Counter/one`)).status, 400);
  assert.equal((await authenticatedFetch(`${base}/ws/BindingProbe/note`)).status, 400);
  assert.equal((await authenticatedFetch(`${base}/ws/ChatRoom/lobby`)).status, 426);
  const oversized = await authenticatedFetch(`${base}/api/Counter/one`, { method: 'POST', body: 'x'.repeat(9000) });
  assert.equal(oversized.status, 400);
  const binary = await connect('binary');
  const closed = once(binary.socket, 'close');
  binary.socket.send(Buffer.from([1, 2]));
  assert.equal((await closed)[0], 1003);
  await Promise.all(sockets.filter(s => s.readyState === WebSocket.OPEN).map(async s => {
    const closed = once(s, 'close'); s.close(1000); await closed;
  }));
  await stop();
  await start();
  assert.deepEqual(await rpc('BindingProbe', 'note', 'read_note'), note);
  assert.equal(await rpc('Counter', 'one', 'value'), 12);
  assert.equal(await rpc('Counter', 'speech-total', 'value'), 1);
  const restored = await connect('lobby', 'speech-total');
  assert.equal(restored.welcome.history[0].text, 'こんにちは 🌊');
  assert.equal(restored.welcome.count, 1);
  const message = nextMessage(restored.socket);
  restored.socket.send('after restart');
  const afterRestart = await message;
  assert.equal(afterRestart.entry.sequence, 2);
  assert.equal(afterRestart.entry.count, 2);
  assert.equal(await rpc('Counter', 'speech-total', 'value'), 2);
  const shared = await connect('another-room', 'speech-total');
  assert.equal(shared.welcome.count, 2);
  const sharedMessage = nextMessage(shared.socket);
  shared.socket.send('shared counter, separate room');
  assert.equal((await sharedMessage).count, 3);
  assert.equal(await rpc('Counter', 'speech-total', 'value'), 3);
  assert.equal(shared.welcome.history.length, 0);
  const historyReader = await connect('lobby', 'speech-total');
  assert.equal(historyReader.welcome.history.length, 2);
  console.log('PASS: workerd R2 stream reads/WebSocket lines, KV/D1 shared bridge, HTTP/RPC, concurrent counters, Future.await across DOs, broadcast, departure, room isolation, Unicode, validation and restart persistence');
} catch (error) {
  await delay(200);
  console.error(logs);
  throw error;
} finally {
  for (const socket of sockets) socket.terminate();
  await stop();
  await rm(temporary, { recursive: true, force: true });
}
