import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BindingAdapter } from '../worker/adapters/bindings.js';
import { RubyRuntime } from '../worker/runtime.js';

const module = new WebAssembly.Module(readFileSync(new URL('../dist/pondro.wasm', import.meta.url)));

test('generic calls preserve receiver and JSON values, and reject missing or non-JSON resources', async () => {
  const service = {
    label: 'service',
    async execute(...args) { return { label: this.label, args }; },
    nothing() {},
    fail() { throw new Error('service failed'); },
    special() { return new Date(); },
    stream() { return new ReadableStream(); }
  };
  const adapter = new BindingAdapter({ SERVICE: service, CACHE: { get: async () => null, put: async () => {} } },
    { SERVICE: 'generic', MISSING: 'generic', CACHE: 'kv' });
  const call = (method, args = [], binding = 'SERVICE') => adapter.invoke({
    operation: 'pondro.call', binding, args: [method, JSON.stringify(args)]
  });
  const args = [null, false, 3, '日本語', [1], { nested: { yes: true } }];
  assert.deepEqual(await call('execute', args), { label: 'service', args });
  assert.equal(await call('nothing'), null);
  await assert.rejects(call('execute', [], 'MISSING'), /not configured/);
  await assert.rejects(call('execute', [], 'UNKNOWN'), /binding type/);
  await assert.rejects(call('absent'), /not callable/);
  await assert.rejects(call('label'), /not callable/);
  await assert.rejects(call('constructor'), /Invalid binding method/);
  await assert.rejects(call('fail'), /service failed/);
  await assert.rejects(call('special'), /JSON|plain/i);
  await assert.rejects(call('stream'), /JSON|plain/i);
  assert.equal(await adapter.invoke({ operation: 'kv.get', binding: 'CACHE', args: ['key'] }), null);
});

test('Ruby synchronous generic calls forward positional and keyword arguments through the real Wasm bridge', async () => {
  const adapter = new BindingAdapter({ SERVICE: {
    label: 'received',
    async execute(...args) { return { label: this.label, args }; }
  } }, { SERVICE: 'generic', MISSING: 'generic' });
  const runtime = new RubyRuntime(module);
  const event = { class: 'GenericProbe', id: 'generic', type: 'rpc', context: adapter.context(),
    payload: { method: 'call_service', args: ['SERVICE', 'execute', [1, '日本語'], { enabled: true }] } };
  try {
    const result = await runtime.dispatch(event, request => adapter.invoke(request));
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.value, { label: 'received', args: [1, '日本語', { enabled: true }] });
    const dynamic = await runtime.dispatch({ ...event,
      payload: { method: 'execute_service', args: [[1, '日本語'], { enabled: true }] } }, request => adapter.invoke(request));
    assert.equal(dynamic.ok, true, dynamic.error);
    assert.deepEqual(dynamic.value, result.value);
    const missing = await runtime.dispatch({ ...event,
      payload: { method: 'call_service', args: ['MISSING', 'execute'] } }, request => adapter.invoke(request));
    assert.deepEqual(missing, { ok: false, error: 'Binding is not configured: MISSING' });
  } finally { runtime.destroy(); }
});

test('explicit async! starts both generic calls before waiting for their results', { timeout: 5000 }, async () => {
  const calls = [];
  const resolvers = [];
  let started;
  const bothStarted = new Promise(resolve => { started = resolve; });
  const adapter = new BindingAdapter({ SERVICE: {
    execute(message) {
      calls.push(message);
      if (calls.length === 2) started();
      return new Promise(resolve => resolvers.push(resolve));
    }
  } }, { SERVICE: 'generic' });
  const runtime = new RubyRuntime(module);
  try {
    const pending = runtime.dispatch({ class: 'GenericProbe', id: 'pair', type: 'rpc',
      context: adapter.context(), payload: { method: 'execute_pair' } }, request => adapter.invoke(request));
    await bothStarted;
    assert.deepEqual(calls, ['first', 'second']);
    resolvers[1]('second result');
    resolvers[0]('first result');
    const result = await pending;
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.value, ['first result', 'second result']);
  } finally { runtime.destroy(); }
});

test('upstream codec and dispatcher are unchanged at the pinned revision', () => {
  const manifest = JSON.parse(readFileSync(new URL('../worker/upstream/source.json', import.meta.url)));
  for (const [name, entry] of Object.entries(manifest.files)) {
    const bytes = readFileSync(new URL(`../worker/upstream/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, name);
  }
});

test('shared dispatcher preserves missing, empty, Unicode, TTL and binding errors', async () => {
  const saved = new Map();
  let options;
  const adapter = new BindingAdapter({ CACHE: {
    async get(key, type) { assert.equal(type, 'arrayBuffer'); return saved.get(key) ?? null; },
    async put(key, value, opts) { saved.set(key, value); options = opts; }
  } }, { CACHE: 'kv' });
  const call = (operation, args, binding = 'CACHE') => adapter.invoke({ operation, args, binding });
  assert.equal(await call('kv.get', ['missing']), null);
  assert.equal(await call('kv.put', ['a', 'こんにちは 🌊', '{"ttl":60}']), null);
  assert.deepEqual(options, { expirationTtl: 60 });
  assert.equal(await call('kv.get', ['a']), 'こんにちは 🌊');
  await call('kv.put', ['empty', '', '{}']);
  assert.equal(await call('kv.get', ['empty']), '');
  await assert.rejects(call('kv.put', ['a', 'bad', '{"ttl":1}']), /at least 60/);
  assert.equal(await call('kv.get', ['a']), 'こんにちは 🌊');
  await assert.rejects(call('kv.get', ['a'], 'UNKNOWN'), /binding type/);
  await assert.rejects(call('d1.execute', ['{}']), /binding type/);
  await assert.rejects(call('stream.read', ['1', '10']), /stream operation/);
  saved.set('binary', new Uint8Array([255]).buffer);
  await assert.rejects(call('kv.get', ['binary']), /encoded data|encoding/i);
});

test('Ruby -> Wasm -> reused bridge: eager binding Futures, bound D1 values and failure recovery', async () => {
  const saved = new Map();
  let row;
  let fail = false;
  const queries = [];
  const adapter = new BindingAdapter({
    CACHE: {
      async get(key) { return saved.get(key) ?? null; },
      async put(key, value) { saved.set(key, value); }
    },
    DB: {
      batch() {},
      prepare(sql) {
        let params = [];
        const statement = {
          bind(...values) { params = values; return statement; },
          async run() {
            if (fail) throw new Error('D1 unavailable');
            queries.push({ sql, params });
            if (sql.startsWith('INSERT')) row = params[1];
            return { success: true, results: [] };
          },
          async first(column) {
            queries.push({ sql, params, column });
            return row ?? null;
          },
          async raw() { return []; }
        };
        return statement;
      }
    }
  }, { CACHE: 'kv', DB: 'd1' });
  const runtime = new RubyRuntime(module);
  const event = { class: 'BindingProbe', id: 'note', type: 'rpc',
    context: adapter.context(), payload: { method: 'store_note', args: ["quote ' and 日本語"] } };
  try {
    assert.deepEqual((await runtime.dispatch({ ...event, type: 'capabilities' })).value, ['bindings']);
    const started = [];
    const invoke = request => { started.push(request.operation); return adapter.invoke(request); };
    const result = await runtime.dispatch(event, invoke);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { kv: "quote ' and 日本語", d1: "quote ' and 日本語" });
    assert.deepEqual(queries[1].params, ['note', "quote ' and 日本語"]);
    assert.equal(queries[2].column, 'body');
    assert.deepEqual(started, ['d1.execute', 'd1.execute', 'kv.put', 'kv.get', 'd1.execute']);
    fail = true;
    assert.deepEqual(await runtime.dispatch(event, invoke), { ok: false, error: 'D1 unavailable' });
    fail = false;
    assert.equal((await runtime.dispatch(event, invoke)).ok, true);
    assert.equal((await runtime.dispatch({ ...event, context: {} }, invoke)).ok, false);
  } finally { runtime.destroy(); }
});
