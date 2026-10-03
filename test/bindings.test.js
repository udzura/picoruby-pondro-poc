import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BindingAdapter } from '../worker/adapters/bindings.js';
import { RubyRuntime } from '../worker/runtime.js';

const module = new WebAssembly.Module(readFileSync(new URL('../dist/pondro.wasm', import.meta.url)));

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
