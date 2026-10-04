import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const temporary = await mkdtemp(join(tmpdir(), 'pondro-fetch-'));
const root = fileURLToPath(new URL('..', import.meta.url));
let slowClosed;
const cancelled = new Promise(resolve => { slowClosed = resolve; });
const upstream = createServer(async (req, res) => {
  if (req.url === '/slow') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('first\n');
    res.on('close', slowClosed);
    return; // Keep the source open to prove read_partial does not buffer to EOF.
  }
  if (req.url === '/binary') { res.end(Buffer.from([255, 0, 1])); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  res.writeHead(201, { 'x-reply': 'yes', 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${req.method}:${req.headers['x-test']}:${body}:日本語🌿`);
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const target = `http://127.0.0.1:${upstream.address().port}`;
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
let worker;
let logs = '';
try {
  await writeFile(join(temporary, 'worker.js'), `
import module from ${JSON.stringify(join(root, 'dist/pondro.wasm'))};
import { RubyRuntime } from ${JSON.stringify(join(root, 'worker/runtime.js'))};
import { BindingAdapter } from ${JSON.stringify(join(root, 'worker/adapters/bindings.js'))};
export default { async fetch(request) {
  if (request.method === 'GET') return new Response('ready');
  const payload = await request.json();
  const bindings = new BindingAdapter({}, {});
  const runtime = new RubyRuntime(module);
  try {
    const result = await runtime.dispatch({ class: 'StreamProbe', id: 'fetch', type: 'rpc',
      context: bindings.context(), payload }, call => bindings.invoke(call), () => bindings.finishEvent());
    return Response.json(result);
  } finally { await bindings.finishEvent(); runtime.destroy(); }
} };
`);
  const config = join(temporary, 'wrangler.json');
  await writeFile(config, JSON.stringify({ name: 'pondro-fetch-test', main: 'worker.js', compatibility_date: '2026-10-04' }));
  worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', config,
    '--port', String(port), '--inspector-port', '0'], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: join(temporary, 'config'), XDG_CACHE_HOME: join(temporary, 'cache') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  worker.stdout.on('data', data => { logs += data; });
  worker.stderr.on('data', data => { logs += data; });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (worker.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
    await delay(200);
  }
  assert.ok(ready, logs);
  async function call(method, args) {
    const response = await fetch(base, { method: 'POST', body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(5000) });
    const result = await response.json();
    assert.equal(result.ok, true, result.error);
    return result.value;
  }
  const options = { method: 'POST', headers: { 'x-test': 'yes' }, body: 'hello' };
  const buffered = await call('fetch_url', [target, options]);
  assert.equal(buffered.status, 201);
  assert.equal(buffered.headers['x-reply'], 'yes');
  assert.equal(buffered.body, 'POST:yes:hello:日本語🌿');
  const streamed = await call('read_url', [target, 'read_all', 1024, options]);
  assert.equal(streamed.metadata.status, 201);
  assert.equal(streamed.metadata.headers['x-reply'], 'yes');
  assert.deepEqual(streamed.bytes, [...new TextEncoder().encode(buffered.body)]);
  const partial = await call('read_url', [target + '/slow', 'read_partial', 1024]);
  assert.deepEqual(partial.bytes, [...new TextEncoder().encode('first\n')]);
  await Promise.race([cancelled, delay(5000).then(() => { throw new Error('Fetch body was not cancelled'); })]);
  assert.deepEqual((await call('read_url', [target + '/binary'])).bytes, [255, 0, 1]);
  console.log('PASS: workerd Ruby fetch/fetch_stream, POST, Unicode, metadata, binary reads, incremental delivery and cancellation');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (worker && worker.exitCode === null) {
    const stopped = once(worker, 'exit');
    worker.kill('SIGTERM');
    const timer = setTimeout(() => worker.kill('SIGKILL'), 5000);
    try { await stopped; } finally { clearTimeout(timer); }
  }
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
