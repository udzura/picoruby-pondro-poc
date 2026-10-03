// Storage/event orchestration is independent of the Cloudflare HTTP adapter.
export class PondroHost {
  constructor(ctx, runtime, adapters = [], remote = null, bindings = null) {
    this.ctx = ctx;
    this.runtime = runtime;
    this.adapters = adapters;
    this.remote = remote;
    this.bindings = bindings;
    this.tail = Promise.resolve();
  }

  dispatch(identity, type, payload, chain = []) {
    const key = JSON.stringify([identity.class, identity.id]);
    if (chain.includes(key) || chain.length >= 16) {
      return Promise.reject(new Error('Cyclic or excessively deep PONDRO RPC'));
    }
    const run = this.tail.then(() => this.run(identity, type, payload, [...chain, key]));
    this.tail = run.catch(() => {});
    return run;
  }

  async run(identity, type, payload, chain) {
    const stored = this.ctx.storage.kv.get('pondro');
    if (stored && (stored.class !== identity.class || stored.id !== identity.id)) {
      throw new Error('PONDRO identity mismatch');
    }
    const result = await this.runtime.dispatch({
      ...identity, type, payload, state: stored?.state ?? {},
      context: Object.assign({}, ...this.adapters.map(adapter => adapter.context()))
    }, request => {
      if (request.kind === 'socket') {
        const adapter = this.adapters.find(candidate => candidate.invokeSocket);
        if (!adapter) throw new Error('WebSocket adapter is unavailable');
        return adapter.invokeSocket(request);
      }
      if (request.kind === 'binding') {
        if (!this.bindings) throw new Error('Bindings are unavailable');
        return this.bindings.invoke(request);
      }
      if (!this.remote) throw new Error('Remote RPC is unavailable');
      const key = JSON.stringify([request.class, request.id]);
      if (chain.includes(key)) throw new Error('Cyclic PONDRO RPC');
      return this.remote(request, chain);
    }, () => this.bindings?.finishEvent());
    if (!result.ok) {
      const error = new Error(result.error);
      error.code = result.code;
      throw error;
    }
    // Only the local snapshot commit is transactional. No transaction spans await.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put('pondro', { ...identity, state: result.state });
    });
    // External effects are best effort after commit, not an atomic outbox.
    for (const effect of result.effects) {
      const adapter = this.adapters.find(adapter => adapter.handles(effect.type));
      if (!adapter) throw new Error(`Unknown effect: ${effect.type}`);
      try {
        adapter.apply(effect);
      } catch (error) {
        console.error('PONDRO effect failed', error);
      }
    }
    return result.value;
  }
}
