import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RubyRuntime } from '../worker/runtime.js';
import { PondroHost } from '../worker/host.js';
import { WebSocketAdapter } from '../worker/adapters/websocket.js';
import { setTimeout as delay } from 'node:timers/promises';

const module = new WebAssembly.Module(readFileSync(new URL('../dist/pondro.wasm', import.meta.url)));
const counter = { class: 'Counter', id: 'one', type: 'rpc', payload: { method: 'increment' } };

test('real PicoRuby Wasm: state rehydration, VM isolation and RPC allowlist', async () => {
  const a = new RubyRuntime(module);
  const b = new RubyRuntime(module);
  try {
    const first = await a.dispatch(counter);
    assert.equal(first.value, 1);
    assert.equal((await a.dispatch({ ...counter, state: first.state })).value, 2);
    assert.equal((await b.dispatch(counter)).value, 1);
    assert.equal((await a.dispatch({ ...counter, payload: { method: 'initialize' } })).ok, false);
    assert.equal((await a.dispatch({ ...counter, type: 'websocket.connect' })).ok, false);
    assert.equal((await a.dispatch(counter)).value, 1);
  } finally { a.destroy(); b.destroy(); }
});

test('HTTP export policy is enforced in Wasm without restricting internal RPC', async () => {
  const runtime = new RubyRuntime(module);
  try {
    assert.equal((await runtime.dispatch({ ...counter, type: 'http.rpc' })).value, 1);
    const room = { class: 'ChatRoom', id: 'private', payload: { method: 'history', http: true, type: 'rpc' } };
    assert.deepEqual((await runtime.dispatch({ ...room, type: 'rpc' })).value, []);
    const denied = await runtime.dispatch({ ...room, type: 'http.rpc' });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'http_not_exported');
  } finally { runtime.destroy(); }
});

test('JSPI suspends, delivers remote failures to Ruby, and rejects VM re-entry', async () => {
  const runtime = new RubyRuntime(module);
  const event = { class: 'ChatRoom', id: 'async', type: 'websocket.message',
    payload: { id: 'a', message: 'hello' }, context: { sockets: ['a'] } };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const pending = runtime.dispatch(event, async request => {
      assert.deepEqual(request, { class: 'Counter', id: 'async', method: 'increment', args: [] });
      await gate;
      return 42;
    });
    await assert.rejects(() => runtime.dispatch(counter), /Concurrent dispatch/);
    assert.throws(() => runtime.destroy(), /suspended/);
    release();
    const result = await pending;
    assert.equal(result.state.messages[0].count, 42);
    const failed = await runtime.dispatch(event, async () => { await delay(1); throw new Error('remote failed'); });
    assert.deepEqual(failed, { ok: false, error: 'remote failed' });
    assert.equal((await runtime.dispatch(counter)).value, 1);
  } finally { release(); runtime.destroy(); }
});

test('host serializes suspended events, commits outside await, and rejects cycles', async () => {
  let stored;
  let inTransaction = false;
  let count = 0;
  const ctx = { storage: {
    kv: { get: () => structuredClone(stored), put: (key, value) => { stored = structuredClone(value); } },
    transactionSync: fn => { inTransaction = true; try { fn(); } finally { inTransaction = false; } }
  } };
  const runtime = new RubyRuntime(module);
  const identity = { class: 'ChatRoom', id: 'async' };
  const host = new PondroHost(ctx, runtime, [], async (request, chain) => {
    assert.equal(inTransaction, false);
    assert.deepEqual(chain, [JSON.stringify(['ChatRoom', 'async'])]);
    await delay(5);
    assert.equal(inTransaction, false);
    return ++count;
  });
  try {
    await Promise.all(Array.from({ length: 5 }, (_, i) => host.dispatch(identity, 'websocket.message', { id: 'a', message: `message ${i}` })));
    assert.equal(stored.state.sequence, 5);
    assert.deepEqual(stored.state.messages.map(entry => entry.count), [1, 2, 3, 4, 5]);
    await assert.rejects(() => host.dispatch(identity, 'rpc', { method: 'history' }, [JSON.stringify(['ChatRoom', 'async'])]), /Cyclic/);
    await assert.rejects(() => host.dispatch(identity, 'websocket.message', { id: 'a', message: 'cycle' }, [JSON.stringify(['Counter', 'async'])]), /Cyclic/);
    assert.equal(stored.state.sequence, 5);
    assert.equal((await host.dispatch(identity, 'rpc', { method: 'history' })).length, 5);
  } finally { runtime.destroy(); }
});

test('host reset waits for an active event and subsequent events restore defaults', async () => {
  let stored;
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = new RubyRuntime(module);
  const identity = { class: 'ChatRoom', id: 'reset' };
  const ctx = { storage: {
    kv: { get: () => structuredClone(stored), put: (_, value) => { stored = structuredClone(value); } },
    transactionSync: fn => fn(), deleteAll: async () => { stored = undefined; }
  } };
  const host = new PondroHost(ctx, runtime, [], async () => { entered(); await gate; return 1; });
  try {
    const event = host.dispatch(identity, 'websocket.message', { id: 'a', message: 'Erase this history.' });
    await started;
    const reset = host.reset();
    release(); await event; await reset;
    assert.equal(stored, undefined);
    assert.deepEqual(await host.dispatch(identity, 'rpc', { method: 'history' }), []);
  } finally { release(); runtime.destroy(); }
});

test('WebSocket opt-in, Unicode, mutable history, trimming and restored socket IDs', async () => {
  let runtime = new RubyRuntime(module);
  const room = { class: 'ChatRoom', id: 'room', context: { sockets: ['a', 'b'] } };
  try {
    const welcome = await runtime.dispatch({ ...room, type: 'websocket.connect', payload: { id: 'a' } }, async () => 0);
    assert.equal(JSON.parse(welcome.effects[0].message).type, 'welcome');
    let state = {};
    for (let i = 0; i < 55; i++) {
      const result = await runtime.dispatch({ ...room, state, type: 'websocket.message', payload: { id: 'a', message: `こんにちは 🌊 ${i}` } }, async () => i + 1);
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.effects.map(e => e.id), ['a', 'b']);
      state = result.state;
    }
    assert.equal(state.messages.length, 50);
    assert.equal(state.messages[0].sequence, 6);
    runtime.destroy();
    runtime = new RubyRuntime(module);
    const history = await runtime.dispatch({ ...room, state, type: 'rpc', payload: { method: 'history' } });
    assert.equal(history.value.length, 50);
    const invalid = await runtime.dispatch({ ...room, state, type: 'websocket.message', payload: { id: 'a', message: '' } });
    assert.equal(invalid.ok, false);
    assert.equal((await runtime.dispatch({ ...room, state, type: 'rpc', payload: { method: 'history' } })).value.length, 50);
    assert.equal((await runtime.dispatch({ ...room, type: 'rpc', payload: { method: 'history' } })).value.length, 0);
  } finally { runtime.destroy(); }
});

test('host persists state before delivery, restores after activation and rejects identity changes', async () => {
  let stored;
  const deliveries = [];
  const socket = { deserializeAttachment: () => ({ id: 'a' }), send: message => {
    assert.equal(stored.state.sequence, 1);
    deliveries.push(JSON.parse(message));
  } };
  const ctx = {
    storage: { kv: { get: () => structuredClone(stored), put: (key, value) => { stored = structuredClone(value); } },
      transactionSync: fn => { const before = structuredClone(stored); try { fn(); } catch (e) { stored = before; throw e; } } },
    getWebSockets: () => [socket]
  };
  const runtime = new RubyRuntime(module);
  const identity = { class: 'ChatRoom', id: 'durable' };
  try {
    const host = new PondroHost(ctx, runtime, [], async () => 1);
    host.adapters.push(new WebSocketAdapter(ctx, host));
    await host.dispatch(identity, 'websocket.message', { id: 'a', message: 'persist me' });
    assert.equal(deliveries.length, 1);
    await assert.rejects(() => host.dispatch(identity, 'websocket.message', { id: 'a', message: '' }));
    assert.equal(stored.state.sequence, 1);
    assert.equal(deliveries.length, 1);
    await assert.rejects(() => host.dispatch({ ...identity, id: 'other' }, 'rpc', { method: 'history' }), /identity/);
    const fresh = new RubyRuntime(module);
    try { assert.equal((await new PondroHost(ctx, fresh).dispatch(identity, 'rpc', { method: 'history' }))[0].text, 'persist me'); }
    finally { fresh.destroy(); }
  } finally { runtime.destroy(); }
});

test('close notifies remaining sockets without changing durable chat history', async () => {
  const runtime = new RubyRuntime(module);
  try {
    const state = { messages: [{ sequence: 1, sender: 'a', text: 'hello' }], sequence: 1, counter_id: null };
    const result = await runtime.dispatch({ class: 'ChatRoom', id: 'room', state,
      context: { sockets: ['a', 'b', 'c'] }, type: 'websocket.close',
      payload: { id: 'b', code: 1000, reason: 'Leaving room' } });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.effects.map(effect => effect.id), ['a', 'c']);
    for (const effect of result.effects) {
      assert.deepEqual(JSON.parse(effect.message), { type: 'left', id: 'b' });
    }
    assert.deepEqual(result.state, state);
  } finally { runtime.destroy(); }
});

test('room binds the selected Counter ID and connect reads without incrementing', async () => {
  const runtime = new RubyRuntime(module);
  const room = { class: 'ChatRoom', id: 'room', type: 'websocket.connect',
    payload: { id: 'a', params: { counter_id: 'shared-total' } } };
  try {
    const welcome = await runtime.dispatch(room, async request => {
      assert.deepEqual(request, { class: 'Counter', id: 'shared-total', method: 'value', args: [] });
      return 12;
    });
    assert.equal(welcome.state.counter_id, 'shared-total');
    assert.equal(JSON.parse(welcome.effects[0].message).count, 12);
    const mismatch = await runtime.dispatch({ ...room, state: welcome.state,
      payload: { id: 'b', params: { counter_id: 'different-total' } } }, () => { throw new Error('Must not call Counter'); });
    assert.equal(mismatch.state.counter_id, 'shared-total');
    assert.deepEqual(mismatch.effects.map(effect => [effect.type, effect.code]), [['socket.close', 4000]]);
  } finally { runtime.destroy(); }
});
