import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RubyRuntime } from '../worker/runtime.js';
import { PondroHost } from '../worker/host.js';

const module = new WebAssembly.Module(readFileSync(new URL('../dist/pondro.wasm', import.meta.url)));
const identity = { class: 'ObjectRegistry', id: 'default' };

test('Ruby ObjectRegistry rehydrates its inventory and retries failed resets without losing entries', async () => {
  let stored;
  let fail = true;
  let runtime;
  let host;
  const resets = [];
  const ctx = { storage: {
    kv: { get: () => stored, put: (_, value) => { stored = value; } },
    transactionSync: fn => fn()
  } };
  function activate() {
    runtime = new RubyRuntime(module);
    host = new PondroHost(ctx, runtime, [], async (request, chain) => {
      assert.equal(request.kind, 'object.reset');
      assert.deepEqual(chain, ['["ObjectRegistry","default"]']);
      if (fail && request.id === 'room') throw new Error('Reset failed');
      resets.push([request.class, request.id]);
      return null;
    });
  }
  const invoke = (method, args = [], type = 'rpc') => host.dispatch(identity, type, { method, args });
  activate();
  try {
    const counter = { class: 'Counter', id: 'one' };
    const room = { class: 'ChatRoom', id: 'room' };
    await invoke('register', [counter]);
    await invoke('register', [counter]);
    await invoke('register', [room]);
    assert.equal(Object.keys(stored.state.objects).length, 2);
    await assert.rejects(invoke('register', [identity]), /Cannot track ObjectRegistry/);
    await assert.rejects(invoke('clear', [], 'http.rpc'), /HTTP/);
    runtime.destroy(); activate();
    await assert.rejects(invoke('clear'), /Reset failed/);
    assert.equal(Object.keys(stored.state.objects).length, 2);
    fail = false;
    assert.deepEqual(await invoke('clear'), { cleared: 2 });
    assert.deepEqual(resets, [['Counter', 'one'], ['Counter', 'one'], ['ChatRoom', 'room']]);
    assert.deepEqual(stored.state.objects, {});
    runtime.destroy(); activate();
    assert.deepEqual(await invoke('clear'), { cleared: 0 });
  } finally { runtime.destroy(); }
});
