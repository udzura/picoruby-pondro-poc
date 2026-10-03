import { createCloudflareBindings } from '../upstream/runtime.js';
import { ReadStreams } from './read-streams.js';
import { encodeHostCall, decodeHostResult, HostResultKind } from '../upstream/host-bridge.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const operations = { 'kv.get': 'kv', 'kv.put': 'kv', 'd1.execute': 'd1', 'r2.get': 'r2', 'ai.run': 'ai' };

// The shared dispatcher owns validation and PHC1/PHB1 encoding. This adapter
// only connects its byte frames to Pondro's event-local JSON/Future ABI.
export class BindingAdapter {
  constructor(env, types) {
    this.env = env;
    this.streams = new ReadStreams();
    this.types = Object.freeze({ ...types });
    this.bridge = createCloudflareBindings(env, this.types).picorbWorkerHostCallBridge;
  }

  context() { return { binding_types: this.types }; }
  handles() { return false; }

  async finishEvent() { await this.streams.finishEvent(); }

  async invoke(request) {
    if (typeof request.operation !== 'string') throw new Error('Invalid binding operation');
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
    const frame = encodeHostCall(request.operation, request.binding, request.args.map(arg => encoder.encode(arg)));
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
      bridge = createCloudflareBindings(env, this.types).picorbWorkerHostCallBridge;
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
    return ['d1.execute', 'ai.run', 'r2.get'].includes(request.operation) ? JSON.parse(text) : text;
  }
}
