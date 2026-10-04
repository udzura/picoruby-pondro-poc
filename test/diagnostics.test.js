import test from 'node:test';
import assert from 'node:assert/strict';
import { PondroHost } from '../worker/host.js';

test('host agent traces are opt-in while AI errors are always logged', async (t) => {
  const info = t.mock.method(console, 'info', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const identity = { class: 'AIChatRoom', id: 'logs' };
  const ctx = { storage: { kv: { put() {} }, transactionSync: fn => fn() } };
  const runtime = { async dispatch(event, invoke) {
    assert.equal(await invoke({ kind: 'log', level: 'info', details: { event: 'example2.agent.model_start' } }), null);
    assert.equal(await invoke({ kind: 'log', details: { event: 'example2.ai_error' } }), null);
    return { ok: true, state: event.state, effects: [], value: 'Completed' };
  } };
  let errors = 0;
  for (const options of [undefined, { diagnostic: false }, { diagnostic: true }]) {
    const host = new PondroHost(ctx, runtime, [], null, null, options);
    assert.equal(await host.runEvent(identity, 'rpc', {}, [], {}), 'Completed');
    const count = options?.diagnostic ? 1 : 0;
    assert.equal(info.mock.callCount(), count);
    assert.equal(error.mock.callCount(), ++errors);
  }
  assert.deepEqual(info.mock.calls[0].arguments, ['PONDRO diagnostic', {
    event: 'example2.agent.model_start', object: identity
  }]);
  assert.deepEqual(error.mock.calls[0].arguments, ['PONDRO diagnostic', {
    event: 'example2.ai_error', object: identity
  }]);
});
