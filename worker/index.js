import { DurableObject } from 'cloudflare:workers';
import module from '../dist/pondro.wasm';
import { RubyRuntime } from './runtime.js';
import { PondroHost } from './host.js';
import { WebSocketAdapter } from './adapters/websocket.js';
import { BindingAdapter } from './adapters/bindings.js';
import { createMockAI } from '../example2/mock-ai.js';
export { DemoAdmin } from './demo-admin.js';

const MAX_BODY_BYTES = 8192;
const CLASSES = ['Counter', 'ChatRoom', 'BindingProbe', 'StreamProbe', 'GenericProbe', 'AICatalog', 'AIParticipant', 'AIChatRoom'];

function demoAdmin(env) {
  return env.DEMO_ADMIN.get(env.DEMO_ADMIN.idFromName('default'));
}

function route(url) {
  const match = url.pathname.match(/^\/(api|ws)\/([^/]+)\/([^/]+)$/);
  if (!match || !CLASSES.includes(match[2])) return null;
  const id = decodeURIComponent(match[3]);
  if (!id || id.length > 128) throw new Error('Invalid object ID');
  return { transport: match[1], class: match[2], id };
}

async function readPayload(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing JSON body');
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('Request body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!payload || typeof payload.method !== 'string' || (payload.args !== undefined && !Array.isArray(payload.args))) {
    throw new Error('Expected method and optional args array');
  }
  return payload;
}

export class PondroObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const mock = env.EXAMPLE2_AI_MODE === 'mock';
    const bindingEnv = mock ? { ...env, AI: createMockAI() } : env;
    const bindings = new BindingAdapter(bindingEnv, { CACHE: 'kv', DB: 'd1', BUCKET: 'r2', AI: 'ai' });
    const example2 = { context: () => ({ ai_mode: mock ? 'mock' : 'live' }), handles: () => false };
    this.host = new PondroHost(ctx, new RubyRuntime(module), [bindings, example2], async (request, chain) => {
      if (!CLASSES.includes(request.class) || typeof request.id !== 'string' || !request.id || request.id.length > 128) {
        throw new Error('Invalid remote PONDRO identity');
      }
      const id = env.PONDRO.idFromName(JSON.stringify([request.class, request.id]));
      await demoAdmin(env).register({ class: request.class, id: request.id });
      // Timeout also bounds independently initiated distributed wait cycles.
      let timer;
      try {
        return await Promise.race([
          env.PONDRO.get(id).invoke({ class: request.class, id: request.id },
            { method: request.method, args: request.args }, chain),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Remote PONDRO RPC timed out')), 10000); })
        ]);
      } finally { clearTimeout(timer); }
    }, bindings);
    this.websocket = new WebSocketAdapter(ctx, this.host);
    this.host.adapters.push(this.websocket);
  }

  invoke(identity, payload, chain = []) {
    return this.host.dispatch(identity, 'rpc', payload, chain);
  }

  reset() {
    for (const socket of this.ctx.getWebSockets()) socket.close(1001, 'Demo data cleared');
    return this.host.reset();
  }

  async fetch(request) {
    let target;
    let payload;
    try {
      target = route(new URL(request.url));
      if (!target) return new Response('Not found', { status: 404 });
      if (target.transport === 'api') {
        if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
        payload = await readPayload(request);
      }
    } catch (error) {
      return new Response(error.message, { status: 400 });
    }
    const identity = { class: target.class, id: target.id };
    try {
      if (target.transport === 'api') {
        return Response.json({ value: await this.host.dispatch(identity, 'http.rpc', payload) });
      }
      return await this.websocket.upgrade(request, identity);
    } catch (error) {
      if (error.code === 'http_not_exported') return new Response('Method is not exported over HTTP', { status: 403 });
      console.error('PONDRO dispatch failed', error);
      return new Response('PONDRO dispatch failed', { status: 500 });
    }
  }

  webSocketMessage(socket, message) {
    return this.websocket.message(socket, message);
  }

  webSocketClose(socket, code, reason) {
    return this.websocket.close(socket, code, reason);
  }

  webSocketError(socket, error) {
    return this.websocket.error(socket, error);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/demo/reset') {
      if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
      if (url.searchParams.get('admin') !== '1') return new Response('Requires admin=1', { status: 403 });
      try { return Response.json(await demoAdmin(env).clear()); }
      catch (error) {
        console.error('Demo reset failed', error);
        return new Response('Demo reset failed', { status: 500 });
      }
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
      let target;
      try { target = route(url); }
      catch (error) { return new Response(error.message, { status: 400 }); }
      if (!target) return new Response('Not found', { status: 404 });
      const id = env.PONDRO.idFromName(JSON.stringify([target.class, target.id]));
      try { await demoAdmin(env).register({ class: target.class, id: target.id }); }
      catch (error) {
        console.error('Demo registration failed', error);
        return new Response('Demo reset is in progress', { status: 503 });
      }
      return env.PONDRO.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
