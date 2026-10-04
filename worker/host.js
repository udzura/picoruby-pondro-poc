// Storage/event orchestration is independent of the Cloudflare HTTP adapter.
export class PondroHost {
  constructor(ctx, runtime, adapters = [], remote = null, bindings = null, { diagnostic = false } = {}) {
    this.ctx = ctx;
    this.runtime = runtime;
    this.adapters = adapters;
    this.remote = remote;
    this.bindings = bindings;
    this.diagnostic = diagnostic;
    this.tail = Promise.resolve();
    this.activeIdentity = null;
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

  reset() {
    const run = this.tail.then(async () => {
      await this.ctx.storage.deleteAll();
      this.activeIdentity = null;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  async run(identity, type, payload, chain) {
    let stored = this.ctx.storage.kv.get('pondro');
    if (stored && (stored.class !== identity.class || stored.id !== identity.id)) {
      throw new Error('PONDRO identity mismatch');
    }
    const key = JSON.stringify([identity.class, identity.id]);
    if (this.activeIdentity && this.activeIdentity !== key) throw new Error('PONDRO identity mismatch');
    if (!this.activeIdentity) {
      // Existing snapshots predate the explicit marker and count as initialized.
      const resume = stored && stored.initialized !== false;
      await this.runEvent(identity, resume ? 'lifecycle.resume' : 'lifecycle.initialize', {}, chain, stored?.state ?? {});
      this.activeIdentity = key;
      stored = this.ctx.storage.kv.get('pondro');
    }
    return this.runEvent(identity, type, payload, chain, stored?.state ?? {});
  }

  async runEvent(identity, type, payload, chain, state) {
    const result = await this.runtime.dispatch({
      ...identity, type, payload, state, managed: true,
      context: Object.assign({}, ...this.adapters.map(adapter => adapter.context()))
    }, request => {
      if (request.kind === 'log') {
        if (request.level === 'info' && !this.diagnostic) return null;
        const log = request.level === 'info' ? console.info : console.error;
        log('PONDRO diagnostic', { ...request.details, object: identity });
        return null;
      }
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
      this.ctx.storage.kv.put('pondro', { ...identity, initialized: true, state: result.state });
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
