import test from 'node:test';
import assert from 'node:assert/strict';
import { PondroHost } from '../worker/host.js';

const identity = { class: 'Object', id: 'one' };

test('host commits hooks once per activation, retries failures and reinitializes after reset', async () => {
  let stored;
  let failHook = true;
  let failCommit = false;
  const events = [];
  const ctx = { storage: {
    kv: { get: () => structuredClone(stored), put: (_, value) => { stored = structuredClone(value); } },
    transactionSync: fn => { if (failCommit) throw new Error('Storage failed'); fn(); },
    deleteAll: async () => { stored = undefined; }
  } };
  const runtime = { async dispatch(event) {
    events.push(event.type);
    if (event.type.startsWith('lifecycle.')) {
      if (failHook) return { ok: false, error: 'Hook failed' };
      return { ok: true, state: { ...event.state, boot: event.type }, effects: [], value: null };
    }
    if (event.payload.method === 'fail') return { ok: false, error: 'Event failed' };
    return { ok: true, state: event.state, effects: [], value: event.state.boot };
  } };
  let host = new PondroHost(ctx, runtime);
  const invoke = (method = 'read') => host.dispatch(identity, 'rpc', { method });
  await assert.rejects(invoke(), /Hook failed/);
  assert.equal(stored, undefined);
  failHook = false; failCommit = true;
  await assert.rejects(invoke(), /Storage failed/);
  assert.equal(stored, undefined);
  failCommit = false;
  await assert.rejects(invoke('fail'), /Event failed/);
  assert.equal(stored.initialized, true);
  assert.equal(await invoke(), 'lifecycle.initialize');
  assert.equal(await invoke(), 'lifecycle.initialize');
  assert.equal(events.filter(type => type === 'lifecycle.initialize').length, 3);
  host = new PondroHost(ctx, runtime);
  failHook = true;
  await assert.rejects(invoke(), /Hook failed/);
  assert.equal(stored.state.boot, 'lifecycle.initialize');
  failHook = false;
  assert.equal(await invoke(), 'lifecycle.resume');
  assert.equal(await invoke(), 'lifecycle.resume');
  assert.equal(events.filter(type => type === 'lifecycle.resume').length, 2);
  await host.reset();
  assert.equal(await invoke(), 'lifecycle.initialize');
});
