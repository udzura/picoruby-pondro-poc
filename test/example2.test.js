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
      const profile = { context: () => ({ object_registry: 'default' }), handles: () => false };
      const runtime = new RubyRuntime(module);
      const host = new PondroHost(ctx, runtime, [binding, profile], (request, chain) =>
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

test('Ruby lifecycle registers Example 2 and playground objects through ordinary RPC without self-registration', async () => {
  const w = world({ async run() { throw new Error('Registration must not invoke AI'); } });
  const list = () => w.get('ObjectRegistry', 'default').dispatch('rpc', { method: 'list' });
  try {
    assert.deepEqual(await list(), []);
    await w.configure('sage', 'Sage', 'Original prompt.');
    await w.connect('garden', 'Alice');
    await w.get('Counter', 'total').dispatch('rpc', { method: 'value' });
    const expected = [
      { class: 'AIParticipant', id: 'sage' }, { class: 'AICatalog', id: 'default' },
      { class: 'AIChatRoom', id: 'garden' }, { class: 'Counter', id: 'total' }
    ];
    assert.deepEqual(await list(), expected);
    await w.get('Counter', 'total').dispatch('rpc', { method: 'increment' });
    w.restore('AIParticipant', 'sage');
    await w.get('AIParticipant', 'sage').dispatch('rpc', { method: 'profile' });
    assert.deepEqual(await list(), expected);
    w.restore('ObjectRegistry', 'default');
    assert.deepEqual(await list(), expected);
  } finally { w.destroy(); }
});

test('AI catalog persists creations, loads saved personas and indexes legacy AI without duplicates', async () => {
  const w = world({ async run() { throw new Error('Listing must not trigger inference'); } });
  const catalog = () => w.get('AICatalog', 'default').dispatch('http.rpc', { method: 'list' });
  try {
    assert.deepEqual(await catalog(), []);
    assert.equal(await w.get('AIParticipant', 'missing').dispatch('http.rpc', { method: 'load' }), null);
    await assert.rejects(w.configure('invalid', '', 'Prompt'), /AI name/);
    assert.deepEqual(await catalog(), []);
    await w.configure('sage', 'Sage', 'Original prompt.');
    await w.configure('sage', 'Other', 'Replace prompt.');
    await w.configure('helper', '助っ人🌿', 'Be kind.');
    assert.deepEqual(await catalog(), [{ id: 'sage', name: 'Sage' }, { id: 'helper', name: '助っ人🌿' }]);
    w.snapshots.set('AIParticipant:legacy', { class: 'AIParticipant', id: 'legacy', state: { name: 'Legacy', prompt: 'Saved before catalog.', rooms: ['old-room'] } });
    const profile = await w.get('AIParticipant', 'legacy').dispatch('http.rpc', { method: 'load' });
    assert.equal(profile.prompt, 'Saved before catalog.');
    assert.deepEqual(profile.rooms, ['old-room']);
    await w.get('AIParticipant', 'legacy').dispatch('http.rpc', { method: 'load' });
    w.restore('AICatalog', 'default');
    assert.deepEqual((await catalog()).map(ai => ai.id), ['sage', 'helper', 'legacy']);
    await assert.rejects(w.get('AICatalog', 'default').dispatch('http.rpc', { method: 'register', args: ['fake', 'Fake'] }), /HTTP/);
  } finally { w.destroy(); }
});

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

test('AI failures preserve human history, release streams and allow the next turn', { timeout: 5000 }, async (t) => {
  t.mock.method(console, 'error', () => {});
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

test('Gemma and GLM disable thinking while Llama retains its default input', async () => {
  for (const model of ['@cf/google/gemma-4-26b-a4b-it', '@cf/zai-org/glm-4.7-flash', '@cf/meta/llama-3.1-8b-instruct-fp8']) {
    let calls = 0;
    const w = world({ async run(selectedModel, input) {
      calls++;
      assert.equal(selectedModel, model);
      assert.equal(input.stream, true);
      assert.equal(input.max_tokens, 512);
      assert.deepEqual(input.chat_template_kwargs, model.includes('/llama-') ? undefined : { enable_thinking: false });
      return source(frame('Hello') + 'data: [DONE]\n\n');
    } });
    try {
      await w.get('AIParticipant', 'helper').dispatch('http.rpc', { method: 'configure', args: ['Helper', 'Be kind.', model] });
      const human = await w.connect('models', 'Human');
      await human.dispatch({ type: 'invite', ai_id: 'helper' });
      await human.dispatch({ type: 'say', text: 'Hello' });
      assert.equal(calls, 1);
      assert.equal(human.events.some(event => event.type === 'message' && event.entry.sender.kind === 'ai' && event.entry.text === 'Hello'), true);
      assert.equal(human.events.some(event => event.type === 'ai_error'), false);
    } finally { w.destroy(); }
  }
});

test('empty reasoning-only replies log model, finish reason and usage without conversation text', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const w = world({ async run() {
    return source('data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"completion_tokens":512}}\n\n' +
      'data: [DONE]\n\n');
  } });
  try {
    await w.get('AIParticipant', 'thinker').dispatch('http.rpc', { method: 'configure',
      args: ['Thinker', 'Secret persona', '@cf/zai-org/glm-4.7-flash'] });
    const human = await w.connect('diagnostics', 'Human');
    await human.dispatch({ type: 'invite', ai_id: 'thinker' });
    await human.dispatch({ type: 'say', text: 'Private human message' });
    assert.match(human.events.find(event => event.type === 'ai_error').text, /finish_reason=length, reasoning_bytes=17/);
    assert.equal(logs.length, 1);
    const diagnostic = logs[0][1];
    assert.equal(diagnostic.model, '@cf/zai-org/glm-4.7-flash');
    assert.deepEqual(diagnostic.object, { class: 'AIChatRoom', id: 'diagnostics' });
    assert.equal(diagnostic.stream.frames, 2);
    assert.equal(diagnostic.stream.usage.completion_tokens, 512);
    assert.equal(diagnostic.stream.done, true);
    assert.doesNotMatch(JSON.stringify(logs), /private reasoning|Secret persona|Private human message/);
  } finally { w.destroy(); }
});

test('AI stream provider errors retain message and code in chat and server diagnostics', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const w = world({ async run() {
    return source('data: {"error":{"message":"Model unavailable","code":1234}}\n\n');
  } });
  try {
    await w.configure('helper', 'Helper', 'Be kind.');
    const human = await w.connect('provider-errors', 'Human');
    await human.dispatch({ type: 'invite', ai_id: 'helper' });
    await human.dispatch({ type: 'say', text: 'Hello' });
    assert.match(human.events.find(event => event.type === 'ai_error').text, /Model unavailable.*1234/);
    assert.match(logs[0][1].error, /Model unavailable.*1234/);
    assert.equal(logs[0][1].stream.frames, 1);
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

test('agent bots execute tools through real Wasm, persist room memory and coexist with ordinary bots', async () => {
  const { createMockAI } = await import('../example2/mock-ai.js');
  const w = world(createMockAI());
  try {
    const configured = await w.get('AIParticipant', 'tools').dispatch('http.rpc', {
      method: 'configure', args: ['Tools', 'Remember requested values.', '@cf/meta/llama-3.1-8b-instruct-fp8', 'agent']
    });
    assert.equal(configured.profile.bot_type, 'agent');
    assert.equal((await w.configure('tools', 'Other', 'Other')).profile.bot_type, 'agent');
    await w.configure('ordinary', 'Ordinary', 'Be kind.');
    const human = await w.connect('memory', 'Human');
    await human.dispatch({ type: 'invite', ai_id: 'tools' });
    await human.dispatch({ type: 'invite', ai_id: 'ordinary' });
    await human.dispatch({ type: 'say', text: 'remember color=青🌿' });
    assert.deepEqual(w.snapshots.get('AIChatRoom:memory').state.memory, { tools: { color: '青🌿' } });
    assert.equal(human.events.some(event => event.text === 'tools used remember.'), true);
    assert.equal(human.events.some(event => event.type === 'ai_error'), false);
    assert.deepEqual(human.events.filter(event => event.type === 'message').map(event => event.entry.sender.id),
      [human.id, 'tools', 'ordinary']);
    w.restore('AIChatRoom', 'memory');
    const restored = await w.connect('memory', 'Returning');
    await restored.dispatch({ type: 'say', text: 'recall color' });
    const reply = restored.events.findLast(event => event.type === 'message' && event.entry.sender.id === 'tools');
    assert.match(reply.entry.text, /青🌿/);
    const other = await w.connect('other-memory', 'Other');
    await other.dispatch({ type: 'invite', ai_id: 'tools' });
    await other.dispatch({ type: 'say', text: 'recall color' });
    assert.match(other.events.findLast(event => event.type === 'message').entry.text, /null/);
    assert.equal((await w.restore('AIParticipant', 'tools').dispatch('http.rpc', { method: 'profile' })).bot_type, 'agent');
    await assert.rejects(w.get('AIChatRoom', 'memory').dispatch('rpc', { method: 'remember', args: [{ key: 'x', value: 'y' }] }), /not exported/);
  } finally { w.destroy(); }
});

test('agent rejects unknown and invalid tools before execution and can handle the next message', async (t) => {
  t.mock.method(console, 'error', () => {});
  let response = { tool_calls: [{ name: 'history', arguments: {} }] };
  const w = world({ async run() { return response; } });
  try {
    await w.get('AIParticipant', 'tools').dispatch('http.rpc', {
      method: 'configure', args: ['Tools', 'Use tools.', '@cf/meta/llama-3.1-8b-instruct-fp8', 'agent']
    });
    const human = await w.connect('invalid-tools', 'Human');
    await human.dispatch({ type: 'invite', ai_id: 'tools' });
    await human.dispatch({ type: 'say', text: 'Unknown tool' });
    assert.match(human.events.findLast(event => event.type === 'ai_error').text, /Unknown tool/);
    response = { tool_calls: [{ name: 'remember', arguments: { key: 'color', value: 42 } }] };
    await human.dispatch({ type: 'say', text: 'Invalid arguments' });
    assert.match(human.events.findLast(event => event.type === 'ai_error').text, /Invalid tool arguments/);
    assert.deepEqual(w.snapshots.get('AIChatRoom:invalid-tools').state.memory, {});
    response = { response: 'Recovered' };
    await human.dispatch({ type: 'say', text: 'Try again' });
    assert.equal(human.events.findLast(event => event.type === 'message').entry.text, 'Recovered');
  } finally { w.destroy(); }
});
