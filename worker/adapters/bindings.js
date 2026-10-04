import { createCloudflareBindings, createFetchBindings } from '../upstream/runtime.js';
import { ReadStreams } from './read-streams.js';
import { encodeHostCall, decodeHostResult, HostResultKind } from '../upstream/host-bridge.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const operations = { 'kv.get': 'kv', 'kv.put': 'kv', 'd1.execute': 'd1', 'r2.get': 'r2', 'ai.run': 'ai', 'pondro.call': 'generic' };

// The shared dispatcher owns validation and PHC1/PHB1 encoding. This adapter
// only connects its byte frames to Pondro's event-local JSON/Future ABI.
export class BindingAdapter {
  constructor(env, types, { fetcher = request => globalThis.fetch(request) } = {}) {
    this.env = env;
    this.fetcher = fetcher;
    this.streams = new ReadStreams();
    this.types = Object.freeze({ ...types });
    this.hostTypes = Object.fromEntries(Object.entries(this.types).filter(([, type]) => type !== 'generic'));
    this.plugins = [{ id: 'pondro', create: (environment, host) => ({
      'pondro.call': { arity: 3, call: async ([binding, method, argumentsJson]) => {
        const name = host.text(binding);
        const methodName = host.text(method);
        if (!Object.hasOwn(this.types, name) || this.types[name] !== 'generic') throw host.bindingError('Binding is not exported: ' + name);
        const target = environment[name];
        if (!Object.hasOwn(environment, name) || target === undefined || target === null) throw host.bindingError('Binding is not configured: ' + name);
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(methodName) || ['constructor', '__proto__', 'prototype'].includes(methodName)) {
          throw host.argumentError('Invalid binding method');
        }
        const fn = target[methodName];
        if (typeof fn !== 'function') throw host.argumentError('Binding method is not callable: ' + methodName);
        const args = JSON.parse(host.text(argumentsJson));
        if (!Array.isArray(args)) throw host.argumentError('Binding arguments must be an array');
        // Use the common bridge's JSON validation for arguments and results.
        host.json(args);
        const value = await Reflect.apply(fn, target, args);
        return host.json(value === undefined ? null : value);
      } }
    }) }];
    this.bridge = createCloudflareBindings(env, this.hostTypes, { plugins: this.plugins }).picorbWorkerHostCallBridge;
  }

  context() { return { binding_types: this.types }; }
  handles() { return false; }

  async finishEvent() { await this.streams.finishEvent(); }

  async invokeFetch(request) {
    if (request.binding !== '' || !Array.isArray(request.args) || request.args.length !== 2 ||
        request.args.some(arg => typeof arg !== 'string')) {
      throw new Error('Invalid fetch arguments');
    }
    let captured;
    try {
      const fetcher = request.operation === 'fetch' ? this.fetcher : async input => {
        const response = await this.fetcher(input);
        // Let upstream reject and cancel redirects. Otherwise keep the real body
        // unread and pass its metadata through the unchanged fetch validator.
        if (response.status >= 300 && response.status < 400) return response;
        captured = response.body;
        return { status: response.status, headers: response.headers, body: null };
      };
      const bridge = createFetchBindings(fetcher).picorbWorkerFetchBridge;
      const result = decodeHostResult(await bridge(...request.args));
      if (result.kind !== HostResultKind.ok) throw new Error(decoder.decode(result.payload));
      const response = JSON.parse(decoder.decode(result.payload));
      if (request.operation === 'fetch') return response;
      const source = captured || new ReadableStream({ start(controller) { controller.close(); } });
      const registered = this.streams.register(source);
      captured = null; // The event-local stream registry now owns cancellation.
      return { status: response.status, headers: response.headers,
        stream_id: new DataView(registered.payload.buffer).getUint32(0, true) };
    } finally {
      if (captured) await captured.cancel().catch(() => {});
    }
  }

  async invoke(request) {
    if (typeof request.operation !== 'string') throw new Error('Invalid binding operation');
    if (request.operation === 'fetch' || request.operation === 'fetch.stream') return this.invokeFetch(request);
    if (request.operation.startsWith('stream.')) {
      if (request.binding !== '' || !['stream.read_partial', 'stream.readline', 'stream.read_all', 'stream.close'].includes(request.operation)) {
        throw new Error('Unsupported stream operation');
      }
      const count = request.operation === 'stream.close' ? 1 : 2;
      if (!Array.isArray(request.args) || request.args.length !== count || request.args.some(arg => typeof arg !== 'string')) {
        throw new Error('Invalid stream arguments');
      }
      const [id, limit] = request.args;
      return this.streams.invoke(request.operation.slice(7), Number(id), Number(limit));
    }
    const type = Object.hasOwn(operations, request.operation) && operations[request.operation];
    if (!type || !Object.hasOwn(this.types, request.binding) || this.types[request.binding] !== type) {
      throw new Error('Unknown operation or mismatched binding type');
    }
    if (!Array.isArray(request.args) || request.args.some(arg => typeof arg !== 'string')) {
      throw new Error('Binding arguments must be UTF-8 strings');
    }
    const args = request.operation === 'pondro.call' ? [request.binding, ...request.args] : request.args;
    const frame = encodeHostCall(request.operation, request.operation === 'pondro.call' ? '' : request.binding, args.map(arg => encoder.encode(arg)));
    let captured;
    let bridge = this.bridge;
    if (request.operation === 'r2.get' || request.operation === 'ai.run') {
      // Give the unchanged dispatcher a per-call environment wrapper. It still
      // validates/serializes resources; Pondro owns the actual readable lifetime.
      const method = request.operation === 'r2.get' ? 'get' : 'run';
      const target = this.env[request.binding];
      const env = { ...this.env };
      if (target) env[request.binding] = new Proxy(target, {
        get(object, key) {
          if (key === method) return async (...args) => {
            const value = await object[method](...args);
            captured = method === 'get' ? value?.body : value instanceof ReadableStream ? value : undefined;
            if (method === 'get' && value) return new Proxy(value, {
              get(object, key) {
                const item = Reflect.get(object, key, object);
                // Workerd metadata objects have native prototypes. Normalize
                // their JSON fields before the shared dispatcher's validation.
                return item && typeof item === 'object' && !(item instanceof Date) && !(item instanceof ReadableStream)
                  ? JSON.parse(JSON.stringify(item)) : item;
              }
            });
            return value;
          };
          const value = object[key];
          return typeof value === 'function' ? value.bind(object) : value;
        }
      });
      bridge = createCloudflareBindings(env, this.hostTypes).picorbWorkerHostCallBridge;
    }
    const result = decodeHostResult(await bridge(frame));
    if (result.kind === HostResultKind.hostStream || (result.kind === HostResultKind.ok && captured)) {
      const registered = this.streams.register(captured);
      const id = new DataView(registered.payload.buffer).getUint32(0, true);
      if (request.operation === 'ai.run') return { stream_id: id };
      const value = JSON.parse(decoder.decode(result.payload));
      return { object: value.object, stream_id: id };
    }
    if (captured) await captured.cancel().catch(() => {});
    if (result.kind === HostResultKind.missing) return null;
    if (result.kind !== HostResultKind.ok) throw new Error(decoder.decode(result.payload));
    if (request.operation === 'kv.put') return null;
    const text = decoder.decode(result.payload);
    return ['d1.execute', 'ai.run', 'r2.get', 'pondro.call'].includes(request.operation) ? JSON.parse(text) : text;
  }
}
