import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BindingAdapter } from '../worker/adapters/bindings.js';
import { RubyRuntime } from '../worker/runtime.js';
import { PondroHost } from '../worker/host.js';
import { WebSocketAdapter } from '../worker/adapters/websocket.js';

const encoder = new TextEncoder();
const module = new WebAssembly.Module(readFileSync(new URL('../dist/pondro.wasm', import.meta.url)));
function fixture(stream, extra = {}) {
  return new BindingAdapter({ BUCKET: {
    head() {}, put() {}, delete() {}, list() {},
    async get(key) { return key === 'missing' ? null : { key, size: 100, body: stream }; }
  }, AI: { async run() { return stream; } }, ...extra }, { BUCKET: 'r2', AI: 'ai' });
}
const read = (adapter, id, operation, limit = 1024) => adapter.invoke({ operation: `stream.${operation}`, binding: '', args: operation === 'close' ? [String(id)] : [String(id), String(limit)] });
const open = adapter => adapter.invoke({ operation: 'r2.get', binding: 'BUCKET', args: ['test', '{}'] });
const bytes = result => result === null ? null : Uint8Array.from(result.bytes);

// Keep the source open after the first chunk: a fill-to-N implementation hangs.
test('stream reads return promptly, serialize competing reads, and close cancels a pending read', { timeout: 5000 }, async () => {
  let controller;
  let cancelled = false;
  const adapter = fixture(new ReadableStream({ start(c) { controller = c; }, cancel() { cancelled = true; } }));
  const object = await open(adapter);
  controller.enqueue(new Uint8Array([255, 0, 1]));
  const first = read(adapter, object.stream_id, 'read_partial', 1024);
  assert.deepEqual([...bytes(await first)], [255, 0, 1]);
  const a = read(adapter, object.stream_id, 'read_partial', 1);
  const b = read(adapter, object.stream_id, 'read_partial', 1);
  controller.enqueue(new Uint8Array([2, 3]));
  assert.deepEqual([...bytes(await a)], [2]);
  assert.deepEqual([...bytes(await b)], [3]);
  const waiting = read(adapter, object.stream_id, 'read_partial', 1);
  await read(adapter, object.stream_id, 'close');
  await waiting.catch(() => {});
  assert.equal(cancelled, true);
  await assert.rejects(read(adapter, object.stream_id, 'read_partial', 1), /expired/);
});

test('readline preserves byte boundaries, blank lines, final line and shared leftovers', { timeout: 5000 }, async () => {
  const text = encoder.encode('日本語\r\n\nlast');
  const adapter = fixture(new ReadableStream({ start(c) {
    for (const byte of text) c.enqueue(new Uint8Array([byte]));
    c.close();
  } }));
  const { stream_id: id } = await open(adapter);
  assert.deepEqual(bytes(await read(adapter, id, 'readline')), encoder.encode('日本語\r\n'));
  assert.deepEqual(bytes(await read(adapter, id, 'readline')), encoder.encode('\n'));
  assert.deepEqual(bytes(await read(adapter, id, 'read_partial', 1)), encoder.encode('l'));
  assert.deepEqual(bytes(await read(adapter, id, 'read_all')), encoder.encode('ast'));
  assert.equal(await read(adapter, id, 'readline'), null);
  assert.equal(await read(adapter, id, 'read_partial', 1), null);
  assert.deepEqual((await read(adapter, id, 'read_all')).bytes, []);
  await adapter.finishEvent();
});

test('limits and errors cancel streams; handles expire across events; R2 missing stays nil', { timeout: 5000 }, async () => {
  let cancelled = 0;
  const adapter = fixture(new ReadableStream({ start(c) { c.enqueue(encoder.encode('too long')); }, cancel() { cancelled++; } }));
  const { stream_id: id } = await open(adapter);
  await assert.rejects(read(adapter, id, 'readline', 2), /max_bytes/);
  assert.equal(cancelled, 1);
  assert.equal(await adapter.invoke({ operation: 'r2.get', binding: 'BUCKET', args: ['missing', '{}'] }), null);
  await adapter.finishEvent();
  await assert.rejects(read(adapter, id, 'read_all'), /expired/);
  await assert.rejects(adapter.invoke({ operation: 'r2.put', binding: 'BUCKET', args: [] }), /operation/);
  const failed = fixture(new ReadableStream({ pull(c) { c.error(new Error('source failed')); } }));
  const opened = await open(failed);
  await assert.rejects(read(failed, opened.stream_id, 'read_all'), /source failed/);
  assert.equal(failed.streams.streams.size, 0);
});

test('AI stream frames use the same read API; event cleanup cancels unused handles', { timeout: 5000 }, async () => {
  let cancelled = false;
  const adapter = fixture(new ReadableStream({ start(c) { c.enqueue(encoder.encode('data: 日本語\n\n')); }, cancel() { cancelled = true; } }));
  const result = await adapter.invoke({ operation: 'ai.run', binding: 'AI', args: ['model', '{"stream":true}', '{}'] });
  assert.deepEqual(bytes(await read(adapter, result.stream_id, 'readline')), encoder.encode('data: 日本語\n'));
  await adapter.finishEvent();
  assert.equal(cancelled, true);
  await assert.rejects(read(adapter, result.stream_id, 'readline'), /expired/);
});

test('real Wasm stream proxies preserve binary bytes and host cleanup on successful and failed events', { timeout: 5000 }, async () => {
  let saved;
  let cancelled = 0;
  const make = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array([255, 0, 228, 184, 173])); }, cancel() { cancelled++; } });
  const adapter = fixture(make(), { BUCKET: { head() {}, put() {}, delete() {}, list() {}, async get(key) { return { key, body: make() }; } } });
  const ctx = { storage: { kv: { get: () => saved, put: (_, value) => { saved = value; } }, transactionSync: fn => fn() } };
  const runtime = new RubyRuntime(module);
  const host = new PondroHost(ctx, runtime, [adapter], null, adapter);
  const identity = { class: 'StreamProbe', id: 'binary' };
  try {
    assert.deepEqual(await host.dispatch(identity, 'rpc', { method: 'read_object', args: ['test', 'read_partial', 5] }), [255, 0, 228, 184, 173]);
    assert.equal(cancelled, 1);
    await assert.rejects(host.dispatch(identity, 'rpc', { method: 'read_object', args: ['test', 'read_all', 2] }), /max_bytes/);
    assert.equal(cancelled, 2);
    assert.equal(adapter.streams.streams.size, 0);
  } finally { runtime.destroy(); }
});

test('real Ruby sends each complete line before stream EOF through send_now', { timeout: 5000 }, async () => {
  let controller;
  const adapter = fixture(new ReadableStream({ start(c) { controller = c; } }));
  const sent = [];
  let delivered;
  const firstLine = new Promise(resolve => { delivered = resolve; });
  const socket = { deserializeAttachment: () => ({ id: 's' }), send(text) { sent.push(JSON.parse(text)); delivered(); } };
  const ctx = { getWebSockets: () => [socket], storage: { kv: { get: () => null, put() {} }, transactionSync: fn => fn() } };
  const runtime = new RubyRuntime(module);
  const host = new PondroHost(ctx, runtime, [adapter], null, adapter);
  host.adapters.push(new WebSocketAdapter(ctx, host));
  let settled = false;
  try {
    const pending = host.dispatch({ class: 'StreamProbe', id: 'live' }, 'websocket.message', { id: 's', message: 'test' }).then(value => { settled = true; return value; });
    for (const byte of encoder.encode('日本語\n')) controller.enqueue(new Uint8Array([byte]));
    await firstLine;
    assert.equal(settled, false);
    assert.deepEqual(sent, [{ type: 'line', text: '日本語\n' }]);
    controller.enqueue(encoder.encode('final'));
    controller.close();
    await pending;
    assert.deepEqual(sent.slice(1), [{ type: 'line', text: 'final' }, { type: 'done' }]);
  } finally { runtime.destroy(); }
});

test('real Wasm AI.stream! returns a StreamFuture for split SSE bytes', { timeout: 5000 }, async () => {
  const source = new ReadableStream({ start(c) {
    for (const byte of encoder.encode('data: 日本語\n\n')) c.enqueue(new Uint8Array([byte]));
    c.close();
  } });
  let opens = 0;
  const adapter = fixture(source, { AI: { async run(model, input, options) {
    assert.equal(input.stream, true);
    assert.equal(input.prompt, 'hello');
    assert.deepEqual(options, {});
    opens++;
    await new Promise(resolve => setTimeout(resolve, 1));
    return source;
  } } });
  const runtime = new RubyRuntime(module);
  try {
    const event = { class: 'StreamProbe', id: 'ai', type: 'rpc', context: adapter.context(),
      payload: { method: 'read_ai', args: ['model', { prompt: 'hello' }, 'readline'] } };
    const result = await runtime.dispatch(event, request => adapter.invoke(request));
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, [...encoder.encode('data: 日本語\n')]);
    assert.equal(opens, 1);
  } finally { await adapter.finishEvent(); runtime.destroy(); }
});

test('event cleanup cancels unawaited reads without deadlocking and joins eager opens', { timeout: 5000 }, async () => {
  let cancelled = 0;
  const bucket = { head() {}, put() {}, delete() {}, list() {}, async get(key) {
    await new Promise(resolve => setTimeout(resolve, 5));
    return { key, body: new ReadableStream({ cancel() { cancelled++; } }) };
  } };
  const adapter = fixture(null, { BUCKET: bucket });
  const runtime = new RubyRuntime(module);
  const ctx = { storage: { kv: { get: () => null, put() {} }, transactionSync: fn => fn() } };
  const host = new PondroHost(ctx, runtime, [adapter], null, adapter);
  try {
    const identity = { class: 'StreamProbe', id: 'abandon' };
    assert.equal(await host.dispatch(identity, 'rpc', { method: 'abandon_read', args: ['test'] }), 'abandoned');
    assert.equal(cancelled, 1);
    assert.equal(await host.dispatch(identity, 'rpc', { method: 'abandon_open', args: ['test'] }), 'abandoned');
    assert.equal(cancelled, 2);
    assert.equal(adapter.streams.streams.size, 0);
  } finally { runtime.destroy(); }
});
