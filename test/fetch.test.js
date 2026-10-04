import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { BindingAdapter } from '../worker/adapters/bindings.js';
import { RubyRuntime } from '../worker/runtime.js';
import { PondroHost } from '../worker/host.js';

const encoder = new TextEncoder();
const module = new WebAssembly.Module(readFileSync(new URL('../dist/pondro.wasm', import.meta.url)));
const request = (operation, url = 'https://example.test/', options = {}) => ({
  operation, binding: '', args: [url, JSON.stringify(options)]
});
const read = (adapter, id, operation, limit = 1024) => adapter.invoke({
  operation: `stream.${operation}`, binding: '', args: operation === 'close' ? [String(id)] : [String(id), String(limit)]
});

// No registered resource binding is needed: use the actual network fetch path.
test('fetch uses HTTP method, headers and body and returns metadata, UTF-8 and HTTP errors', async () => {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(req.url === '/error' ? 503 : 201, { 'x-reply': 'yes', 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${req.method}:${req.headers['x-test']}:${body}:日本語🌿`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const adapter = new BindingAdapter({}, {});
  try {
    const response = await adapter.invoke(request('fetch', url, { method: 'POST', headers: { 'x-test': 'yes' }, body: 'hello' }));
    assert.equal(response.status, 201);
    assert.equal(response.headers['x-reply'], 'yes');
    assert.equal(response.body, 'POST:yes:hello:日本語🌿');
    assert.equal((await adapter.invoke(request('fetch', url + '/error'))).status, 503);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('fetch and fetch_stream share URL, options and redirect validation', async () => {
  let calls = 0;
  let cancelled = 0;
  const adapter = new BindingAdapter({}, {}, { fetcher: async req => {
    calls++;
    assert.equal(req.redirect, 'manual');
    assert.ok(req.signal);
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 302 });
  } });
  for (const operation of ['fetch', 'fetch.stream']) {
    for (const url of ['invalid', 'file:///tmp/example', 'https://user:password@example.test']) {
      await assert.rejects(adapter.invoke(request(operation, url)), /URL|credentials/);
    }
    await assert.rejects(adapter.invoke(request(operation, undefined, { headers: { x: 1 } })), /headers/);
    await assert.rejects(adapter.invoke(request(operation, undefined, { body: 1 })), /body/);
    await assert.rejects(adapter.invoke(request(operation, undefined, { redirect: 'follow' })), /unsupported field/);
    await assert.rejects(adapter.invoke(request(operation)), /redirect.*302/);
    await assert.rejects(adapter.invoke({ ...request(operation), binding: 'AI' }), /Invalid fetch/);
  }
  assert.equal(calls, 2);
  assert.equal(cancelled, 2);
  const failing = new BindingAdapter({}, {}, { fetcher: async () => { throw new Error('network down'); } });
  await assert.rejects(failing.invoke(request('fetch')), /network request failed/);
  await assert.rejects(failing.invoke(request('fetch.stream')), /network request failed/);
});

test('fetch buffers at most 1 MiB and requires UTF-8; streams preserve arbitrary bytes', async () => {
  const make = body => new BindingAdapter({}, {}, { fetcher: async () => new Response(body) });
  await assert.rejects(make(new Uint8Array([255])).invoke(request('fetch')), /UTF-8/);
  let cancelled = false;
  const huge = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(make(huge).invoke(request('fetch')), /1 MiB/);
  assert.equal(cancelled, true);
  const adapter = make(new Uint8Array([255, 0, 1]));
  const { stream_id } = await adapter.invoke(request('fetch.stream'));
  assert.deepEqual((await read(adapter, stream_id, 'read_all')).bytes, [255, 0, 1]);
  await adapter.finishEvent();
  await assert.rejects(read(adapter, stream_id, 'read_all'), /expired/);
});

test('fetch_stream opens without buffering, reads promptly and cancels at event completion', { timeout: 5000 }, async () => {
  let controller;
  let reads = 0;
  let cancelled = 0;
  const stream = new ReadableStream({ start(c) { controller = c; }, pull() { reads++; }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const adapter = new BindingAdapter({}, {}, { fetcher: async () => new Response(stream, { status: 206, headers: { 'x-meta': 'yes' } }) });
  const response = await adapter.invoke(request('fetch.stream'));
  assert.equal(response.status, 206);
  assert.equal(response.headers['x-meta'], 'yes');
  assert.equal(reads, 0, 'opening must not consume the body');
  controller.enqueue(encoder.encode('first\n'));
  assert.deepEqual((await read(adapter, response.stream_id, 'read_partial', 1024)).bytes, [...encoder.encode('first\n')]);
  const pending = read(adapter, response.stream_id, 'read_partial', 1);
  await adapter.finishEvent();
  await pending.catch(() => {});
  assert.equal(cancelled, 1);
});

test('fetch_stream supports bodyless responses and bounded line reads', async () => {
  const empty = new BindingAdapter({}, {}, { fetcher: async () => new Response(null, { status: 204 }) });
  const opened = await empty.invoke(request('fetch.stream'));
  assert.equal(opened.status, 204);
  assert.equal(await read(empty, opened.stream_id, 'read_partial'), null);
  assert.deepEqual((await read(empty, opened.stream_id, 'read_all')).bytes, []);
  await read(empty, opened.stream_id, 'close');
  await read(empty, opened.stream_id, 'close');
  const adapter = new BindingAdapter({}, {}, { fetcher: async () => new Response('日本語\r\n\nlast') });
  const { stream_id: id } = await adapter.invoke(request('fetch.stream'));
  assert.deepEqual((await read(adapter, id, 'readline')).bytes, [...encoder.encode('日本語\r\n')]);
  assert.deepEqual((await read(adapter, id, 'readline')).bytes, [10]);
  await assert.rejects(read(adapter, id, 'read_all', 2), /max_bytes/);
  assert.equal(adapter.streams.streams.size, 0);
});

test('real Wasm bindings.fetch and fetch_stream use JSPI, metadata and automatic cleanup', async () => {
  let calls = 0;
  let cancelled = 0;
  const adapter = new BindingAdapter({}, {}, { fetcher: async req => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(req.method, 'POST');
    assert.equal(await req.text(), 'hello');
    return new Response('日本語🌿\n', { status: 201, headers: { 'x-test': 'yes' } });
  } });
  const runtime = new RubyRuntime(module);
  const ctx = { storage: { kv: { get: () => null, put() {} }, transactionSync: fn => fn() } };
  const host = new PondroHost(ctx, runtime, [adapter], null, adapter);
  const identity = { class: 'StreamProbe', id: 'fetch' };
  try {
    const options = { method: 'POST', body: 'hello' };
    const response = await host.dispatch(identity, 'rpc', { method: 'fetch_url', args: ['https://example.test', options] });
    assert.equal(response.status, 201);
    assert.equal(response.body, '日本語🌿\n');
    const streamed = await host.dispatch(identity, 'rpc', { method: 'read_url', args: ['https://example.test', 'readline', 1024, options] });
    assert.deepEqual(streamed.metadata, { status: 201, headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-test': 'yes' } });
    assert.deepEqual(streamed.bytes, [...encoder.encode('日本語🌿\n')]);
    assert.equal(calls, 2, 'metadata and reads share the same fetch');
    assert.equal(adapter.streams.streams.size, 0);
    adapter.fetcher = async () => {
      await new Promise(resolve => setTimeout(resolve, 2));
      return new Response(new ReadableStream({ cancel() { cancelled++; } }));
    };
    assert.equal(await host.dispatch(identity, 'rpc', { method: 'abandon_fetch', args: ['https://example.test'] }), 'abandoned');
    assert.equal(cancelled, 1);
    adapter.fetcher = async () => new Response(new Uint8Array([255, 0]));
    assert.deepEqual((await host.dispatch(identity, 'rpc', { method: 'read_url', args: ['https://example.test'] })).bytes, [255, 0]);
    await assert.rejects(host.dispatch(identity, 'rpc', { method: 'fetch_url', args: ['https://example.test'] }), /UTF-8/);
    adapter.fetcher = async () => { throw new Error('failed'); };
    await assert.rejects(host.dispatch(identity, 'rpc', { method: 'read_url', args: ['https://example.test'] }), /network request failed/);
  } finally { await adapter.finishEvent(); runtime.destroy(); }
});
