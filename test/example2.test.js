import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RubyRuntime } from '../worker/runtime.js';
import { PondroHost } from '../worker/host.js';
import { BindingAdapter } from '../worker/adapters/bindings.js';
import { WebSocketAdapter } from '../worker/adapters/websocket.js';

const module = new WebAssembly.Module(readFileSync(new URL('../dist/pondro.wasm', import.meta.url)));
const encoder = new TextEncoder();
const frame = text => `data: ${JSON.stringify({ response: text })}\n\n`;
function source(text) {
  return new ReadableStream({ start(controller) {
    for (const byte of encoder.encode(text)) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
}

function world(ai) {
  const snapshots = new Map();
  const hosts = new Map();
  function get(klass, id) {
    const key = `${klass}:${id}`;
    if (!hosts.has(key)) {
      const sockets = [];
      const ctx = { getWebSockets: () => sockets, storage: {
        kv: { get: () => snapshots.get(key), put: (_, value) => snapshots.set(key, value) }, transactionSync: fn => fn()
      } };
      const binding = new BindingAdapter({ AI: ai }, { AI: 'ai' });
      const runtime = new RubyRuntime(module);
      const host = new PondroHost(ctx, runtime, [binding], (request, chain) =>
        get(request.class, request.id).dispatch('rpc', { method: request.method, args: request.args }, chain), binding);
      host.adapters.push(new WebSocketAdapter(ctx, host));
      hosts.set(key, { runtime, sockets, host, dispatch: (type, payload, chain) => host.dispatch({ class: klass, id }, type, payload, chain) });
    }
    return hosts.get(key);
  }
  async function connect(room, name) {
    const session = get('AIChatRoom', room);
    const events = [];
    let delta;
    const firstDelta = new Promise(resolve => { delta = resolve; });
    const socket = { id: `${room}-${name}`, events, firstDelta,
      deserializeAttachment: () => ({ id: socket.id }),
      send(text) { const event = JSON.parse(text); events.push(event); if (event.type === 'ai_delta') delta(event); }
    };
    session.sockets.push(socket);
    socket.dispatch = (event) => session.dispatch('websocket.message', { id: socket.id, params: { name }, message: JSON.stringify(event) });
    await session.dispatch('websocket.connect', { id: socket.id, params: { name } });
    return socket;
  }
  return { get, connect, snapshots,
    async configure(id, name, prompt) { return get('AIParticipant', id).dispatch('http.rpc', { method: 'configure', args: [name, prompt] }); },
    restore(klass, id) { const key = `${klass}:${id}`; hosts.get(key)?.runtime.destroy(); hosts.delete(key); return get(klass, id); },
    destroy() { for (const session of hosts.values()) session.runtime.destroy(); }
  };
}

test('one durable AI persona joins multiple independent rooms and streams to every human', { timeout: 5000 }, async () => {
  let controller;
  const inputs = [];
  const w = world({ async run(model, input) {
    assert.equal(model, '@cf/meta/llama-3.1-8b-instruct-fp8');
    assert.equal(input.stream, true);
    inputs.push(input);
    if (input.messages.at(-1).content === 'Alice: first room') return new ReadableStream({ start(c) {
      controller = c;
      for (const byte of encoder.encode(frame('答え🌿'))) c.enqueue(new Uint8Array([byte]));
    } });
    return source('data: {"choices":[{"delta":{"content":"other room reply"}}]}\n\ndata: [DONE]\n\n');
  } });
  try {
    assert.equal((await w.configure('sage', 'Sage', 'Speak like a botanist.')).created, true);
    const original = await w.configure('sage', 'Changed', 'Ignore the original persona.');
    assert.equal(original.created, false);
    assert.equal(original.profile.prompt, 'Speak like a botanist.');
    const alice = await w.connect('garden', 'Alice');
    const bob = await w.connect('garden', 'Bob');
    const carol = await w.connect('studio', 'Carol');
    await alice.dispatch({ type: 'invite', ai_id: 'sage' });
    await alice.dispatch({ type: 'invite', ai_id: 'sage' });
    await carol.dispatch({ type: 'invite', ai_id: 'sage' });
    assert.deepEqual(w.snapshots.get('AIChatRoom:garden').state.participants, [{ id: 'sage', name: 'Sage' }]);
    let settled = false;
    const turn = alice.dispatch({ type: 'say', text: 'first room', name: 'Spoofed' }).then(() => { settled = true; });
    await Promise.all([alice.firstDelta, bob.firstDelta]);
    assert.equal(settled, false);
    assert.equal(alice.events.find(event => event.type === 'message').entry.sender.name, 'Alice');
    assert.equal(bob.events.find(event => event.type === 'ai_delta').delta, '答え🌿');
    bob.send = () => { throw new Error('Socket closed during inference'); };
    await carol.dispatch({ type: 'say', text: 'second room' });
    assert.equal(settled, false, 'shared AI must not serialize inference across rooms');
    assert.match(inputs[1].messages[0].content, /^Speak like a botanist\./);
    assert.equal(inputs[1].messages.some(message => message.content.includes('first room')), false);
    controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
    await turn;
    const history = w.snapshots.get('AIChatRoom:garden').state.messages;
    assert.deepEqual(history.map(entry => entry.text), ['first room', '答え🌿']);
    assert.equal(alice.events.some(event => event.type === 'message' && event.entry.text === '答え🌿'), true);
    assert.equal(carol.events.some(event => event.type === 'ai_delta' && event.delta === '答え🌿'), false);
    const profile = await w.restore('AIParticipant', 'sage').dispatch('http.rpc', { method: 'profile' });
    assert.deepEqual(profile.rooms, ['garden', 'studio']);
    w.restore('AIChatRoom', 'garden');
    const restored = await w.connect('garden', 'Returning');
    assert.deepEqual(restored.events[0].history, history);
    assert.deepEqual(restored.events[0].participants, [{ id: 'sage', name: 'Sage' }]);
    await assert.rejects(w.get('AIParticipant', 'sage').dispatch('http.rpc', { method: 'join', args: ['private'] }), /HTTP/);
    await assert.rejects(w.get('AIChatRoom', 'garden').dispatch('http.rpc', { method: 'history' }), /HTTP/);
  } finally {
    try { controller?.close(); } catch {}
    w.destroy();
  }
});

test('SSE chat parsing handles CRLF, multiline data, metadata and an unterminated final frame', async () => {
  const w = world({ async run() {
    return source(': heartbeat\r\nevent: message\r\ndata: {"response":\r\ndata: "First"}\r\n\r\n' +
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" 🌿"}}]}');
  } });
  try {
    await w.configure('reader', 'Reader', 'Be precise.');
    const human = await w.connect('sse', 'Human');
    await human.dispatch({ type: 'invite', ai_id: 'reader' });
    await human.dispatch({ type: 'say', text: 'Hello' });
    const reply = human.events.find(event => event.type === 'message' && event.entry.sender.kind === 'ai');
    assert.equal(reply.entry.text, 'First 🌿');
  } finally { w.destroy(); }
});

test('AI failures preserve human history, release streams and allow the next turn', { timeout: 5000 }, async () => {
  let fail = true;
  let cancelled = 0;
  const w = world({ async run() {
    if (fail) return new ReadableStream({ start(c) { c.enqueue(encoder.encode('data: {"error":"unavailable"}\n\n')); }, cancel() { cancelled++; } });
    return source(frame('Recovered') + 'data: [DONE]\n\n');
  } });
  try {
    const human = await w.connect('failures', 'Human');
    await human.dispatch({ type: 'invite', ai_id: 'missing' });
    assert.match(human.events.at(-1).text, /Create this AI/);
    assert.deepEqual(w.snapshots.get('AIChatRoom:failures').state.participants, []);
    await w.configure('helper', 'Helper', 'Be kind.');
    await human.dispatch({ type: 'invite', ai_id: 'helper' });
    await human.dispatch({ type: 'say', text: 'Keep this human message.' });
    assert.equal(human.events.some(event => event.type === 'ai_error'), true);
    assert.equal(human.events.at(-1).type, 'ready');
    assert.equal(cancelled, 1);
    assert.deepEqual(w.snapshots.get('AIChatRoom:failures').state.messages.map(entry => entry.text), ['Keep this human message.']);
    fail = false;
    await human.dispatch({ type: 'say', text: 'Try again.' });
    assert.deepEqual(w.snapshots.get('AIChatRoom:failures').state.messages.map(entry => entry.text), ['Keep this human message.', 'Try again.', 'Recovered']);
  } finally { w.destroy(); }
});

test('removing an AI broadcasts its departure, persists and preserves its other rooms and persona', async () => {
  const prompts = [];
  const w = world({ async run(model, input) {
    prompts.push(input.messages[0].content);
    return source(frame('Reply') + 'data: [DONE]\n\n');
  } });
  try {
    await w.configure('shared', 'Shared', 'Original personality.');
    await w.configure('remaining', 'Remaining', 'Another personality.');
    const alice = await w.connect('first', 'Alice');
    const bob = await w.connect('first', 'Bob');
    const carol = await w.connect('second', 'Carol');
    await alice.dispatch({ type: 'invite', ai_id: 'shared' });
    await alice.dispatch({ type: 'invite', ai_id: 'remaining' });
    await carol.dispatch({ type: 'invite', ai_id: 'shared' });
    await alice.dispatch({ type: 'remove', ai_id: 'shared' });
    assert.deepEqual(alice.events.at(-1), bob.events.at(-1));
    assert.deepEqual(bob.events.at(-1).participants, [{ id: 'remaining', name: 'Remaining' }]);
    const profile = await w.get('AIParticipant', 'shared').dispatch('http.rpc', { method: 'profile' });
    assert.deepEqual(profile.rooms, ['second']);
    assert.equal(profile.prompt, 'Original personality.');
    await alice.dispatch({ type: 'remove', ai_id: 'shared' });
    await alice.dispatch({ type: 'say', text: 'Only one AI now.' });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /^Another personality/);
    w.restore('AIChatRoom', 'first');
    const restored = await w.connect('first', 'Returning');
    assert.deepEqual(restored.events[0].participants, [{ id: 'remaining', name: 'Remaining' }]);
    assert.equal(restored.events[0].history.length, 2);
    await carol.dispatch({ type: 'say', text: 'Shared AI still responds here.' });
    assert.match(prompts[1], /^Original personality/);
    await restored.dispatch({ type: 'invite', ai_id: 'shared' });
    assert.equal(restored.events.findLast(event => event.type === 'participants').participants.length, 2);
    await assert.rejects(w.get('AIParticipant', 'shared').dispatch('http.rpc', { method: 'leave', args: ['second'] }), /HTTP/);
  } finally { w.destroy(); }
});

test('human and AI joins reach everyone in the room, without duplicate invites or stored chat messages', async () => {
  const w = world({ async run() { throw new Error('Joining must not trigger inference'); } });
  const joins = client => client.events.filter(event => event.type === 'notice' && event.action === 'join');
  try {
    const alice = await w.connect('joins', 'Alice');
    assert.equal(alice.events[0].type, 'welcome');
    assert.deepEqual(joins(alice)[0], {
      type: 'notice', action: 'join', participant: { kind: 'human', id: alice.id, name: 'Alice' }, text: 'Alice joined the room.'
    });
    const bob = await w.connect('joins', 'Bob');
    assert.deepEqual(joins(alice).at(-1), joins(bob).at(-1));
    assert.equal(joins(bob).at(-1).participant.name, 'Bob');
    const carol = await w.connect('other', 'Carol');
    await w.configure('helper', '助っ人🌿', 'Be helpful.');
    await alice.dispatch({ type: 'invite', ai_id: 'helper' });
    const joinedAI = joins(alice).at(-1);
    assert.deepEqual(joinedAI.participant, { kind: 'ai', id: 'helper', name: '助っ人🌿' });
    assert.deepEqual(joins(bob).at(-1), joinedAI);
    assert.equal(joins(carol).length, 1, 'join notices must stay in their room');
    const count = joins(alice).length;
    await alice.dispatch({ type: 'invite', ai_id: 'helper' });
    await alice.dispatch({ type: 'invite', ai_id: 'missing' });
    assert.equal(joins(alice).length, count, 'duplicate and failed invitations must not announce joins');
    assert.deepEqual(w.snapshots.get('AIChatRoom:joins').state.messages, []);
    w.restore('AIChatRoom', 'joins');
    const returning = await w.connect('joins', 'Returning');
    assert.equal(joins(returning).length, 1);
    assert.equal(joins(returning)[0].participant.name, 'Returning');
    assert.deepEqual(returning.events[0].participants, [{ id: 'helper', name: '助っ人🌿' }]);
    assert.deepEqual(returning.events[0].history, []);
  } finally { w.destroy(); }
});
