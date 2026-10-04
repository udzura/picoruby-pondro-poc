import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const temporary = await mkdtemp(join(tmpdir(), 'pondro-example2-'));
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const sockets = [];
let worker;
let logs = '';

async function start() {
  logs = '';
  worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev',
    '--config', 'example2/wrangler.mock.jsonc', '--port', String(port), '--inspector-port', '0',
    '--persist-to', join(temporary, 'state')], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: join(temporary, 'config'), XDG_CACHE_HOME: join(temporary, 'cache') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  worker.stdout.on('data', data => { logs += data; });
  worker.stderr.on('data', data => { logs += data; });
  for (let i = 0; i < 150; i++) {
    if (worker.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${base}/example2/`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await delay(200);
  }
  throw new Error(`Wrangler startup timed out: ${logs}`);
}
async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const exited = once(worker, 'exit');
  worker.kill('SIGTERM');
  const timer = setTimeout(() => worker.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function rpc(id, method, args = [], klass = 'AIParticipant') {
  const response = await fetch(`${base}/api/${klass}/${encodeURIComponent(id)}`, {
    method: 'POST', body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(5000)
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).value;
}
async function connect(room, name) {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws/AIChatRoom/${room}?name=${encodeURIComponent(name)}`);
  sockets.push(socket);
  const events = [];
  const waiting = new Set();
  socket.on('message', message => {
    const event = JSON.parse(message.toString());
    events.push(event);
    for (const waiter of waiting) if (waiter.predicate(event)) { clearTimeout(waiter.timer); waiting.delete(waiter); waiter.resolve(event); }
  });
  const wait = predicate => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => { waiting.delete(waiter); reject(new Error('Chat event timeout')); }, 5000);
      waiting.add(waiter);
    });
  };
  await once(socket, 'open');
  const welcome = await wait(event => event.type === 'welcome');
  return { socket, events, wait, welcome, send: event => socket.send(JSON.stringify(event)) };
}

try {
  await start();
  assert.match(await (await fetch(`${base}/example2/`)).text(), /A room for everyone/);
  assert.equal(await rpc('sage', 'profile'), null);
  const created = await rpc('sage', 'configure', ['Sage', 'Be a curious botanist.']);
  assert.equal(created.created, true);
  assert.equal((await rpc('sage', 'configure', ['Other', 'Replace the original'])).profile.prompt, 'Be a curious botanist.');
  assert.deepEqual(await rpc('default', 'list', [], 'AICatalog'), [{ id: 'sage', name: 'Sage' }]);
  assert.equal((await rpc('sage', 'load')).prompt, 'Be a curious botanist.');
  const alice = await connect('garden', 'Alice');
  const bob = await connect('garden', 'Bob');
  const carol = await connect('studio', 'Carol');
  assert.equal(alice.welcome.ai_mode, 'mock');
  const bobJoin = await bob.wait(event => event.type === 'notice' && event.action === 'join' && event.participant.name === 'Bob');
  assert.equal(bobJoin.participant.kind, 'human');
  assert.deepEqual(await alice.wait(event => event.type === 'notice' && event.action === 'join' && event.participant.name === 'Bob'), bobJoin);
  alice.send({ type: 'invite', ai_id: 'sage' });
  for (const client of [alice, bob]) assert.equal((await client.wait(event => event.type === 'participants')).participants[0].id, 'sage');
  const aiJoins = await Promise.all([alice, bob].map(client => client.wait(event => event.type === 'notice' && event.action === 'join' && event.participant.kind === 'ai')));
  assert.deepEqual(aiJoins[0], aiJoins[1]);
  assert.equal(aiJoins[0].participant.name, 'Sage');
  carol.send({ type: 'invite', ai_id: 'sage' });
  await carol.wait(event => event.type === 'participants');
  alice.send({ type: 'say', text: 'こんにちは 🌿' });
  await Promise.all([alice, bob].map(client => client.wait(event => event.type === 'ai_delta')));
  const replies = await Promise.all([alice, bob].map(client => client.wait(event => event.type === 'message' && event.entry.sender.kind === 'ai')));
  assert.deepEqual(replies[0], replies[1]);
  assert.match(replies[0].entry.text, /curious botanist/);
  assert.match(replies[0].entry.text, /Alice: こんにちは 🌿/);
  assert.equal(carol.events.some(event => event.type === 'message'), false);
  carol.send({ type: 'say', text: 'A separate conversation.' });
  const otherReply = await carol.wait(event => event.type === 'message' && event.entry.sender.kind === 'ai');
  assert.match(otherReply.entry.text, /Carol: A separate conversation/);
  assert.doesNotMatch(otherReply.entry.text, /こんにちは/);
  const profile = await rpc('sage', 'profile');
  assert.deepEqual(profile.rooms, ['garden', 'studio']);
  alice.send({ type: 'remove', ai_id: 'sage' });
  await Promise.all([alice, bob].map(client => client.wait(event => event.type === 'participants' && event.participants.length === 0)));
  assert.deepEqual((await rpc('sage', 'profile')).rooms, ['studio']);
  const marker = alice.events.length;
  alice.send({ type: 'say', text: 'No AI in this room now.' });
  await alice.wait(event => event.type === 'ready' && alice.events.indexOf(event) >= marker);
  assert.equal(alice.events.slice(marker).some(event => event.type === 'ai_start'), false);
  const denied = await fetch(`${base}/api/AIParticipant/sage`, { method: 'POST', body: '{"method":"join","args":["hidden"]}' });
  assert.equal(denied.status, 403);
  const closed = once(bob.socket, 'close'); bob.socket.close(1000, 'Leaving'); await closed;
  assert.match((await alice.wait(event => event.type === 'notice' && event.text === 'Bob left the room.')).text, /Bob left/);
  await Promise.all(sockets.filter(socket => socket.readyState === WebSocket.OPEN).map(async socket => {
    const closed = once(socket, 'close'); socket.close(1000); await closed;
  }));
  await stop(); await start();
  assert.deepEqual(await rpc('default', 'list', [], 'AICatalog'), [{ id: 'sage', name: 'Sage' }]);
  assert.equal((await rpc('sage', 'profile')).prompt, 'Be a curious botanist.');
  const restored = await connect('garden', 'Returning');
  assert.deepEqual(restored.welcome.history.map(entry => entry.sender.kind), ['human', 'ai', 'human']);
  assert.equal(restored.welcome.history[0].text, 'こんにちは 🌿');
  assert.deepEqual(restored.welcome.participants, []);
  restored.send({ type: 'invite', ai_id: 'sage' });
  await restored.wait(event => event.type === 'participants' && event.participants.length === 1);
  assert.equal((await rpc('sage', 'profile')).prompt, 'Be a curious botanist.');
  const solo = await connect('human-only', 'Solo');
  solo.send({ type: 'say', text: 'Human-only room history.' });
  await solo.wait(event => event.type === 'ready');
  assert.equal(await rpc('reset-counter', 'increment', [], 'Counter'), 1);
  const refused = await fetch(`${base}/api/demo/reset`, { method: 'POST' });
  assert.equal(refused.status, 403);
  assert.equal((await rpc('sage', 'profile')).name, 'Sage');
  const closures = [solo.socket, restored.socket].map(socket => once(socket, 'close'));
  const cleared = await fetch(`${base}/api/demo/reset?admin=1`, { method: 'POST' });
  assert.equal(cleared.status, 200, await cleared.clone().text());
  assert.ok((await cleared.json()).cleared >= 6);
  await Promise.all(closures);
  assert.deepEqual(await rpc('default', 'list', [], 'AICatalog'), []);
  assert.equal(await rpc('sage', 'profile'), null);
  assert.equal(await rpc('reset-counter', 'value', [], 'Counter'), 0);
  const emptyRoom = await connect('garden', 'AfterReset');
  assert.deepEqual(emptyRoom.welcome.history, []);
  assert.deepEqual(emptyRoom.welcome.participants, []);
  const emptySolo = await connect('human-only', 'AfterResetSolo');
  assert.deepEqual(emptySolo.welcome.history, []);
  await stop(); await start();
  assert.equal(await rpc('sage', 'profile'), null);
  assert.deepEqual(await rpc('default', 'list', [], 'AICatalog'), []);
  assert.equal((await rpc('sage', 'configure', ['New Sage', 'A new personality.'])).created, true);
  assert.deepEqual(await rpc('default', 'list', [], 'AICatalog'), [{ id: 'sage', name: 'New Sage' }]);
  console.log('PASS: example2 workerd WebSocket broadcasts, streamed AI replies, shared persona, room isolation, immutable prompt, removal/re-invitation, departure and restart persistence (mock AI)');
} catch (error) {
  await delay(200); console.error(logs); throw error;
} finally {
  for (const socket of sockets) socket.terminate();
  await stop();
  await rm(temporary, { recursive: true, force: true });
}
