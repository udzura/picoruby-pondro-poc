const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class RubyRuntime {
  constructor(module) {
    if (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function') {
      throw new Error('PONDRO requires WebAssembly JSPI support');
    }
    this.pending = new Map();
    this.nextToken = 1;
    this.busy = false;
    const wasi = {
      proc_exit: (code) => { throw new Error(`Wasm exited: ${code}`); },
      fd_close: () => 0,
      fd_seek: () => 8,
      fd_fdstat_get: () => 8,
      fd_write: (fd, vectors, count, written) => {
        const view = new DataView(this.instance.exports.memory.buffer);
        let bytes = 0;
        for (let i = 0; i < count; i++) bytes += view.getUint32(vectors + i * 8 + 4, true);
        view.setUint32(written, bytes, true);
        return 0;
      },
      environ_sizes_get: (count, size) => {
        const view = new DataView(this.instance.exports.memory.buffer);
        view.setUint32(count, 0, true);
        view.setUint32(size, 0, true);
        return 0;
      },
      environ_get: () => 0,
      clock_time_get: (id, precision, pointer) => {
        new DataView(this.instance.exports.memory.buffer).setBigUint64(pointer, BigInt(Date.now()) * 1000000n, true);
        return 0;
      }
    };
    this.instance = new WebAssembly.Instance(module, {
      wasi_snapshot_preview1: wasi,
      env: { emscripten_notify_memory_growth: () => {} },
      pondro: {
        rpc_start: (pointer, length) => {
          const request = JSON.parse(decoder.decode(new Uint8Array(this.instance.exports.memory.buffer, pointer, length)));
          const token = this.nextToken++;
          // Start immediately; retain fulfilled failures to avoid unhandled rejections.
          let started;
          try { started = Promise.resolve(this.invokeRpc(request)); }
          catch (error) { started = Promise.reject(error); }
          const promise = started.then(
            value => ({ ok: true, value }),
            error => ({ ok: false, error: error.message ?? String(error) })
          );
          this.pending.set(token, promise);
          return token;
        },
        rpc_await: new WebAssembly.Suspending(async token => {
          const pending = this.pending.get(token);
          const result = pending ? await pending : { ok: false, error: 'Unknown Future' };
          return this.writeJSON(result);
        })
      }
    });
    this.instance.exports._initialize?.();
    if (!this.instance.exports.pondro_init()) throw new Error('PicoRuby initialization failed');
    this.run = WebAssembly.promising(this.instance.exports.pondro_dispatch);
  }

  writeJSON(value) {
    const wasm = this.instance.exports;
    const bytes = encoder.encode(JSON.stringify(value));
    const input = wasm.malloc(bytes.length + 1);
    if (!input) throw new Error('PicoRuby input allocation failed');
    const memory = new Uint8Array(wasm.memory.buffer);
    memory.set(bytes, input);
    memory[input + bytes.length] = 0;
    return input;
  }

  async dispatch(event, invokeRpc = () => { throw new Error('Remote RPC is unavailable'); }) {
    if (this.busy) throw new Error('Concurrent dispatch into one Ruby VM is not allowed');
    this.busy = true;
    this.invokeRpc = invokeRpc;
    const wasm = this.instance.exports;
    let input = 0;
    let output = 0;
    try {
      input = this.writeJSON(event);
      output = await this.run(input);
      if (!output) throw new Error('PicoRuby dispatch failed');
      const result = new Uint8Array(wasm.memory.buffer);
      const end = result.indexOf(0, output);
      if (end === -1) throw new Error('Invalid PicoRuby result');
      return JSON.parse(decoder.decode(result.subarray(output, end)));
    } finally {
      // Even unawaited eager calls finish before the event lifetime ends.
      await Promise.all(this.pending.values());
      this.pending.clear();
      this.invokeRpc = null;
      this.busy = false;
      if (output) wasm.free(output);
      if (input) wasm.free(input);
    }
  }

  destroy() {
    if (this.busy) throw new Error('Cannot destroy a suspended Ruby VM');
    this.instance.exports.pondro_destroy();
  }
  get memoryBytes() { return this.instance.exports.memory.buffer.byteLength; }
}
