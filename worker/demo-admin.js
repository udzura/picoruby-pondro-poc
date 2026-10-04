import { DurableObject } from 'cloudflare:workers';

// Demo-only inventory: unlike the AI catalog, this includes empty/human-only
// rooms and every PONDRO reached through HTTP, WebSocket or internal RPC.
export class DemoAdmin extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.objects = new Map();
    this.clearing = false;
    ctx.blockConcurrencyWhile(async () => {
      for (const identity of await ctx.storage.get('objects') || []) {
        this.objects.set(JSON.stringify([identity.class, identity.id]), identity);
      }
    });
  }

  async register(identity) {
    if (this.clearing) throw new Error('Demo reset is in progress');
    const key = JSON.stringify([identity.class, identity.id]);
    if (this.objects.has(key)) return;
    this.objects.set(key, identity);
    try { await this.ctx.storage.put('objects', [...this.objects.values()]); }
    catch (error) { this.objects.delete(key); throw error; }
  }

  async clear() {
    if (this.clearing) throw new Error('Demo reset is already in progress');
    this.clearing = true;
    try {
      const count = this.objects.size;
      for (const [name] of this.objects) {
        await this.env.PONDRO.get(this.env.PONDRO.idFromName(name)).reset();
      }
      await this.ctx.storage.deleteAll();
      this.objects.clear();
      return { cleared: count };
    } finally {
      this.clearing = false;
    }
  }
}
